import { GrouparooRecord } from "../../models/GrouparooRecord";
import { RecordProperty } from "../../models/RecordProperty";
import { Property } from "../../models/Property";
import { Source } from "../../models/Source";
import { Group } from "../../models/Group";
import { Destination } from "../../models/Destination";
import { Export } from "../../models/Export";
import { GroupMember } from "../../models/GroupMember";
import { Log } from "../../models/Log";
import { api, config } from "actionhero";
import Sequelize, {
  Op,
  OrderItem,
  WhereAttributeHash,
  QueryTypes,
} from "sequelize";
import { waitForLock } from "../locks";
import { RecordPropertyOps } from "./recordProperty";
import { GroupRule } from "../../models/GroupRule";
import { Import } from "../../models/Import";
import { Mapping } from "../../models/Mapping";
import { SourceOps } from "./source";

export interface RecordPropertyType {
  [key: string]: {
    id: RecordProperty["id"];
    state: RecordProperty["state"];
    values: Array<string | number | boolean | Date>;
    configId: ReturnType<Property["getConfigId"]>;
    type: Property["type"];
    unique: Property["unique"];
    directlyMapped: Property["directlyMapped"];
    isArray: Property["isArray"];
    identifying: Property["identifying"];
    valueChangedAt: RecordProperty["valueChangedAt"];
    confirmedAt: RecordProperty["confirmedAt"];
    stateChangedAt: RecordProperty["stateChangedAt"];
    startedAt: RecordProperty["startedAt"];
    createdAt: RecordProperty["createdAt"];
    updatedAt: RecordProperty["updatedAt"];
  };
}

export namespace RecordOps {
  /**
   * Get the Properties of this GrouparooRecord
   */
  export async function getProperties(record: GrouparooRecord) {
    const recordProperties =
      record.recordProperties ||
      (await RecordProperty.scope(null).findAll({
        where: { recordId: record.id },
        order: [["position", "ASC"]],
      }));

    const properties = await Property.findAllWithCache();

    const hash: RecordPropertyType = {};

    for (const i in recordProperties) {
      const property = properties.find(
        (r) => r.id === recordProperties[i].propertyId
      );
      if (!property) {
        await recordProperties[i].destroy();
        continue;
      }

      const key = property.key;
      if (!hash[key]) {
        hash[key] = {
          id: recordProperties[i].propertyId,
          state: recordProperties[i].state,
          values: [],
          configId: property.getConfigId(),
          type: property.type,
          unique: property.unique,
          directlyMapped: property.directlyMapped,
          isArray: property.isArray,
          identifying: property.identifying,
          valueChangedAt: recordProperties[i].valueChangedAt,
          confirmedAt: recordProperties[i].confirmedAt,
          stateChangedAt: recordProperties[i].stateChangedAt,
          startedAt: recordProperties[i].startedAt,
          createdAt: recordProperties[i].createdAt,
          updatedAt: recordProperties[i].updatedAt,
        };
      }

      hash[key].values.push(await recordProperties[i].getValue());

      const timeFields = [
        "valueChangedAt",
        "confirmedAt",
        "stateChangedAt",
        "createdAt",
        "updatedAt",
      ];

      timeFields.forEach((field) => {
        if (hash[key][field] < recordProperties[i][field]) {
          hash[key][field] = recordProperties[i][field];
        }
      });
    }

    return hash;
  }

  /**
   * Search & List GrouparooRecords
   */
  export async function search({
    limit,
    offset,
    state,
    groupId,
    searchKey,
    searchValue,
    order,
    caseSensitive,
  }: {
    limit?: number;
    offset?: number;
    state?: string;
    groupId?: string;
    searchKey?: string | number;
    searchValue?: string;
    order?: OrderItem[];
    caseSensitive?: boolean;
  }) {
    if (!limit) limit = 100;
    if (!offset) offset = 0;
    if (!order) order = [["createdAt", "asc"]];
    if (caseSensitive === undefined || caseSensitive === null)
      caseSensitive = true;

    const ands: (Sequelize.Utils.Where | WhereAttributeHash)[] = [];
    const include: Array<any> = [];
    let countRequiresIncludes = false;

    // Are we searching for GrouparooRecords in a specific state?
    if (state) ands.push({ state });

    // Are we searching for a specific RecordProperty?
    if (searchKey && searchValue) {
      countRequiresIncludes = true;
      include.push(RecordProperty);
      countRequiresIncludes = true;

      const property = await Property.findOneWithCache(`${searchKey}`, "key");
      if (!property) throw new Error(`cannot find a property for ${searchKey}`);

      ands.push(
        Sequelize.where(
          Sequelize.col("recordProperties.propertyId"),
          property.id
        )
      );
      if (searchValue.toLowerCase() === "null" || searchValue === "") {
        ands.push(
          Sequelize.where(Sequelize.col("recordProperties.rawValue"), null)
        );
      } else {
        const op = searchValue.includes("%") ? Op.like : Op.eq;
        ands.push(
          Sequelize.where(
            !caseSensitive
              ? Sequelize.fn(
                  "LOWER",
                  Sequelize.col("recordProperties.rawValue")
                )
              : Sequelize.col("recordProperties.rawValue"),
            {
              [op]: !caseSensitive
                ? Sequelize.fn("LOWER", searchValue)
                : searchValue,
            }
          )
        );
      }
    }

    // Are we limiting the search for only members of a Specific Group?
    if (groupId) {
      countRequiresIncludes = true;
      include.push(GroupMember);
      ands.push(
        Sequelize.where(Sequelize.col("groupMembers.groupId"), groupId)
      );
    }

    // Load the records in full now that we know the relevant records
    const recordIds = (
      await GrouparooRecord.findAll({
        attributes: ["id"],
        include,
        where: { [Op.and]: ands },
        limit,
        offset,
        order,
        subQuery: false,
      })
    ).map((p) => p.id);

    const records = await GrouparooRecord.findAll({
      where: { id: recordIds },
      order,
      include: [RecordProperty],
    });

    const total = await GrouparooRecord.count({
      include: countRequiresIncludes ? include : undefined,
      where: { [Op.and]: ands },
      distinct: true,
    });

    return { records, total };
  }

  /**
   * Add or Update a Property on GrouparooRecords
   */
  export async function addOrUpdateProperties(
    records: GrouparooRecord[],
    recordProperties: {
      [key: string]: Array<string | number | boolean | Date> | any;
    }[],
    toLock = true,
    ignoreMissingProperties = false
  ) {
    if (records.length === 0) return;
    if (records.length !== recordProperties.length) {
      throw new Error(
        "GrouparooRecords and RecordProperty arrays are not the same length"
      );
    }

    const releaseLocks: Function[] = [];
    const bulkCreates = [];
    const bulkDeletes = { where: { [Op.or]: [] } };
    const properties = await Property.findAllWithCache();
    const now = new Date();

    // load existing record properties
    const existingRecordProperties = await RecordProperty.findAll({
      where: { recordId: { [Op.in]: records.map((p) => p.id) } },
    });

    try {
      let recordOffset = 0;
      for (const record of records) {
        if (toLock) {
          const response = await waitForLock(`record:${record.id}`);
          releaseLocks.push(response.releaseLock);
        }

        if (record.isNewRecord) await record.save();

        const keys = Object.keys(recordProperties[recordOffset]);
        checkKeys: for (const key of keys) {
          if (key === "id") continue checkKeys;
          if (key === "_meta") continue checkKeys;

          const h: { [key: string]: Array<string | number | boolean | Date> } =
            {};
          h[key] = Array.isArray(recordProperties[recordOffset][key])
            ? recordProperties[recordOffset][key]
            : [recordProperties[recordOffset][key]];

          const property =
            properties.find((p) => p.id === key) ??
            properties.find((p) => p.key === key);

          if (!property) {
            if (ignoreMissingProperties) continue;
            throw new Error(`cannot find a property for id or key \`${key}\``);
          }

          // add new GrouparooRecord Properties to batch
          let position = 0;
          buildQueries: for (const value of h[key]) {
            if (position > 0 && !property.isArray) {
              throw new Error(
                "cannot set multiple record properties for a non-array property"
              );
            }

            const existingRecordProperty = existingRecordProperties.find(
              (p) =>
                p.recordId === record.id &&
                p.propertyId === property.id &&
                p.position === position
            );
            const rawValue = await RecordPropertyOps.buildRawValue(
              value,
              property.type
            );

            bulkCreates.push({
              id: existingRecordProperty
                ? existingRecordProperty.id
                : undefined,
              recordId: record.id,
              propertyId: property.id,
              position,
              rawValue,
              state: "ready",
              stateChangedAt: now,
              confirmedAt: now,
              valueChangedAt:
                !existingRecordProperty ||
                !existingRecordProperty.valueChangedAt ||
                !existingRecordProperty.rawValue ||
                rawValue !== existingRecordProperty.rawValue
                  ? now
                  : existingRecordProperty.valueChangedAt,
              unique: property.unique,
            });

            position++;
          }

          // delete old properties we didn't update
          bulkDeletes.where[Op.or].push({
            recordId: record.id,
            propertyId: property.id,
            position: { [Op.gte]: position },
          });
        }

        recordOffset++;
      }

      if (bulkCreates.length > 0) {
        await RecordProperty.bulkCreate(bulkCreates, {
          updateOnDuplicate: [
            "state",
            "unique",
            "stateChangedAt",
            "confirmedAt",
            "valueChangedAt",
            "rawValue",
            "updatedAt",
          ],
        });
      }
      if (bulkDeletes.where[Op.or].length > 0) {
        await RecordProperty.destroy(bulkDeletes);
      }
    } finally {
      for (const releaseLock of releaseLocks) await releaseLock();
    }
  }

  async function resolvePendingProperties(
    record: GrouparooRecord,
    sourceId?: string
  ) {
    const pendingProperties = await RecordProperty.findAll({
      where: { recordId: record.id, state: "pending" },
    });

    const clearRecordPropertyIds = [];
    for (let recordProperty of pendingProperties) {
      const property = await Property.findOneWithCache(
        recordProperty.propertyId
      );
      if (!sourceId || property.sourceId === sourceId) {
        clearRecordPropertyIds.push(recordProperty.id);
      }
    }

    await RecordProperty.update(
      {
        state: "ready",
        rawValue: null,
        stateChangedAt: new Date(),
        valueChangedAt: new Date(),
        confirmedAt: new Date(),
      },
      { where: { id: clearRecordPropertyIds } }
    );
  }

  /**
   * Remove a Property on this GrouparooRecord
   */
  export async function removeProperty(record: GrouparooRecord, key: string) {
    const property = await Property.findOne({ where: { key } });
    if (!property) return;

    return RecordProperty.destroy({
      where: { recordId: record.id, propertyId: property.id },
    });
  }

  /**
   * Remove all Properties from this GrouparooRecord
   */
  export async function removeProperties(
    record: GrouparooRecord,
    properties: Array<string>
  ) {
    for (const i in properties) {
      await record.removeProperty(properties[i]);
    }
  }

  export async function buildNullProperties(
    records: GrouparooRecord[],
    state = "pending"
  ) {
    const properties = await Property.findAllWithCache();

    const bulkArgs = [];
    const now = new Date();

    for (const record of records) {
      const recordProperties = await record.getProperties();

      for (const key in properties) {
        const property = properties[key];
        if (!recordProperties[property.key]) {
          bulkArgs.push({
            recordId: record.id,
            propertyId: property.id,
            state,
            stateChangedAt: now,
            valueChangedAt: now,
            confirmedAt: now,
          });
        }
      }
    }

    if (bulkArgs.length > 0) await RecordProperty.bulkCreate(bulkArgs);

    return bulkArgs.length;
  }

  export async function updateGroupMemberships(records: GrouparooRecord[]) {
    const results: { [recordId: string]: { [groupId: string]: boolean } } = {};
    const groups = await Group.scope("notDraft").findAll({
      include: [GroupRule],
    });

    for (const record of records) results[record.id] = {};

    for (const group of groups) {
      const belongs = await group.updateRecordsMembership(records);
      for (const recordId of Object.keys(belongs)) {
        results[recordId][group.id] = belongs[recordId];
      }
    }

    return results;
  }

  /**
   * Import the properties of this GrouparooRecord
   */
  export async function _import(
    record: GrouparooRecord,
    toSave = true,
    toLock = true
  ) {
    let releaseLock: Function;

    if (toLock) {
      const lockObject = await waitForLock(`record:${record.id}`);
      releaseLock = lockObject.releaseLock;
    }

    try {
      const sources = await Source.findAll({
        where: { state: "ready" },
        include: [Mapping, Property],
      });
      const sortedSources = SourceOps.sortByDependencies(sources);

      for (const source of sortedSources) {
        const { canImport, properties } = await source.import(record);

        // We need to save each property as it is loaded so it can be used as a mapping for the next source
        if (canImport && toSave) {
          await addOrUpdateProperties([record], [properties], false);
          await resolvePendingProperties(record, source.id);
        }
      }

      if (toSave) {
        await buildNullProperties([record]);

        await record.save();
        await RecordProperty.update(
          { state: "ready" },
          { where: { recordId: record.id } }
        );
      }

      return record;
    } catch (error) {
      throw error;
    } finally {
      if (toLock) await releaseLock();
    }
  }

  /**
   * Export this GrouparooRecord to all relevant Sources
   */
  export async function _export(
    record: GrouparooRecord,
    force = false,
    oldGroups: Group[] = [],
    saveExports = true,
    sync = true
  ) {
    const groups = await record.$get("groups");

    const destinations = await Destination.destinationsForGroups([
      ...oldGroups,
      ...groups,
    ]);

    // We want to find destinations which aren't in the above set and already have an Export for this GrouparooRecord.
    // That's a sign that the GrouparooRecord is about to get a toDelete export
    const existingExportNotDeleted: { destinationId: string }[] =
      await api.sequelize.query(
        `
    SELECT * from "exports"
    JOIN (
      SELECT "destinationId", MAX("createdAt") as "createdAt"
      FROM "exports"
      WHERE "recordId" = '${record.id}'
      GROUP BY "destinationId"
    ) AS "latest"
    ON "latest"."destinationId" = "exports"."destinationId" AND "latest"."createdAt" = "exports"."createdAt"
    WHERE "recordId" = '${record.id}'
    AND "toDelete" = false
    ;
    `,
        {
          type: QueryTypes.SELECT,
          model: Export,
        }
      );

    for (const _export of existingExportNotDeleted) {
      if (!destinations.map((d) => d.id).includes(_export.destinationId)) {
        const destination = await Destination.findById(_export.destinationId);
        destinations.push(destination);
      }
    }

    return Promise.all(
      destinations.map((destination) =>
        destination.exportRecord(
          record,
          sync, // sync = true -> do the export in-line
          force, // force = true -> do the export even if it looks like the data hasn't changed
          saveExports // saveExports = true -> should we really save these exports, or do we just want examples for the next export?
        )
      )
    );
  }

  /**
   * Fully Import and Export a record
   */
  export async function sync(
    record: GrouparooRecord,
    force = true,
    toExport = true
  ) {
    const oldGroups = await record.$get("groups");

    await record.markPending();
    await record.import();
    await record.updateGroupMembership();
    await record.update({ state: "ready" });
    return RecordOps._export(record, force, oldGroups, toExport);
  }

  /**
   * The method you'll be using to create records with arbitrary data.
   * Hash looks like {email: "person@example.com", id: 123}
   *
   * This method today always returns a record by finding it or making a a new one... unless it throws because the source isn't allowed to make new records.
   */
  export async function findOrCreateByUniqueRecordProperties(
    hash: {
      [key: string]: Array<string | number | boolean | Date>;
    },
    source?: boolean | Source
  ) {
    let record: GrouparooRecord;
    let isNew = false;
    let recordProperty: RecordProperty;
    const uniqueProperties = (await Property.findAllWithCache()).filter(
      (p) => p.unique === true
    );
    const uniquePropertiesHash = {};

    uniqueProperties.forEach((property) => {
      if (hash[property.key] !== null && hash[property.key] !== undefined) {
        uniquePropertiesHash[property.id] = hash[property.key];
      } else if (
        hash[property.id] !== null &&
        hash[property.id] !== undefined
      ) {
        uniquePropertiesHash[property.id] = hash[property.id];
      }
    });

    if (Object.keys(uniquePropertiesHash).length === 0) {
      throw new Error(
        `there are no unique record properties provided in ${JSON.stringify(
          hash
        )}`
      );
    }

    const uniquePropertyIds = Object.keys(uniquePropertiesHash);
    const lockReleases = [];

    try {
      for (const i in uniquePropertyIds) {
        const id = uniquePropertyIds[i];
        const value = uniquePropertiesHash[id];
        const property = uniqueProperties.find((r) => r.id === id);

        const { releaseLock } = await waitForLock(
          `recordProperty:${id}:${value}`
        );
        lockReleases.push(releaseLock);

        recordProperty = await RecordProperty.findOne({
          where: {
            propertyId: property.id,
            rawValue: String(value),
          },
        });

        if (recordProperty) break;
      }

      if (recordProperty) {
        record = await GrouparooRecord.findOne({
          where: { id: recordProperty.recordId },
        });
      } else {
        const canCreateNewRecord =
          typeof source === "boolean"
            ? source
            : source instanceof Source
            ? (await Property.findAllWithCache())
                .filter((p) => p.unique === true && p.sourceId === source.id)
                .map((p) => p.key)
                .filter((key) => !!hash[key]).length > 0
            : false;

        if (!canCreateNewRecord) {
          throw new Error(
            `could not create a new record because no record property in ${JSON.stringify(
              hash
            )} is unique and owned by the source`
          );
        }

        record = await GrouparooRecord.create();
        record = await record.reload();
        const { releaseLock } = await waitForLock(`record:${record.id}`);
        lockReleases.push(releaseLock);
        await addOrUpdateProperties([record], [uniquePropertiesHash], false);
        await buildNullProperties([record]);

        isNew = true;
      }

      return { record, isNew };
    } finally {
      await Promise.all(lockReleases.map((releaseLock) => releaseLock()));
    }
  }

  /**
   * Mark many GrouparooRecords and all of their properties as pending
   */
  export async function markPendingByIds(
    recordIds: string[],
    includeProperties = true
  ) {
    if (includeProperties) {
      await RecordProperty.update(
        { state: "pending", startedAt: null },
        { where: { recordId: { [Op.in]: recordIds } } }
      );
    }

    await GrouparooRecord.update(
      { state: "pending" },
      { where: { id: { [Op.in]: recordIds } } }
    );
  }

  /**
   * Look for records that don't have a directlyMapped property and are done importing/exporting.
   */

  export async function getRecordsToDestroy() {
    const limit: number = config.batchSize.imports;
    let records: GrouparooRecord[] = [];

    const directlyMappedProperties = (await Property.findAllWithCache()).filter(
      (p) => p.directlyMapped
    );

    if (directlyMappedProperties.length === 0) {
      // We have no directly mapped Property and every record should be removed
      // It's safe to assume that if there are no Properties, we aren't exporting
      records = await GrouparooRecord.findAll({
        attributes: ["id"],
        where: { state: "ready" },
        limit,
      });
    } else {
      // We have directly mapped Properties and we only want to remove those GrouparooRecords with a null "user_id" (directlyMapped) Property (and are ready with no exports)
      records = await api.sequelize.query(
        `
  SELECT "id" FROM "records"
  WHERE "state"='ready'
  AND "id" IN (
    SELECT DISTINCT("recordId") FROM "recordProperties"
    JOIN properties ON "properties"."id"="recordProperties"."propertyId"
    WHERE
      "properties"."directlyMapped"=true
      AND "rawValue" IS NULL
  )
  LIMIT ${limit};
        `,
        {
          model: GrouparooRecord,
        }
      );
    }

    return records;
  }

  /**
   * Import records whose directlyMapped property has not been confirmed after a certain date.
   */
  export async function confirmExistence(
    limit: number,
    fromDate: Date,
    sourceId?: string
  ) {
    const properties = await Property.findAllWithCache();
    const directlyMapped = properties.filter(
      (p) => p.directlyMapped && (!sourceId || sourceId === p.sourceId)
    );

    const recordProperties = await RecordProperty.findAll({
      where: {
        state: "ready",
        confirmedAt: {
          [Op.lt]: fromDate,
        },
        rawValue: {
          [Op.ne]: null,
        },
        propertyId: directlyMapped.map((p) => p.id),
      },
      limit,
    });

    const recordIds = recordProperties.map((pp) => pp.recordId);

    // Only mark record and directlyMapped property pending
    await markPendingByIds(recordIds, false);
    await RecordProperty.update(
      { state: "pending", startedAt: null },
      { where: { id: recordProperties.map((pp) => pp.id) } }
    );

    const uniqueRecordIds = recordIds.filter(
      (val, idx, arr) => arr.indexOf(val) === idx
    );
    return uniqueRecordIds.length;
  }

  /**
   * Merge 2 GrouparooRecords, favoring the first GrouparooRecord
   */
  export async function merge(
    record: GrouparooRecord,
    otherRecord: GrouparooRecord
  ) {
    const { releaseLock: releaseLockForRecord } = await waitForLock(
      `record:${record.id}`
    );
    const { releaseLock: releaseLockForOtherRecord } = await waitForLock(
      `record:${otherRecord.id}`
    );

    try {
      // transfer properties, keeping the newest values
      const properties = await record.getProperties();
      const otherProperties = await otherRecord.getProperties();
      const newProperties = {};
      for (const key in otherProperties) {
        if (
          !properties[key] ||
          (otherProperties[key]?.updatedAt?.getTime() >
            properties[key]?.updatedAt?.getTime() &&
            otherProperties[key].values.length > 0 &&
            !(
              otherProperties[key].values.length === 1 &&
              (otherProperties[key].values[0] === null ||
                otherProperties[key].values[0] === undefined)
            ))
        ) {
          newProperties[key] = otherProperties[key].values;
        }
      }

      // delete other record so unique record properties will be available
      await otherRecord.destroy();
      await addOrUpdateProperties([record], [newProperties], false);

      // log the merge
      await Log.create({
        topic: "record",
        verb: "merge",
        message: `merged with record ${otherRecord.id}`,
        ownerId: record.id,
        data: { previousProperties: properties, otherProperties },
      });

      // re-import and update groups
      delete record.recordProperties;
      await record.buildNullProperties();
      await record.markPending();

      return record;
    } finally {
      await releaseLockForRecord();
      await releaseLockForOtherRecord();
    }
  }

  /**
   * Find records that are not ready but whose properties are and make them ready.
   * Then, process the related imports.
   */
  export async function makeReadyAndCompleteImports(
    limit = 100,
    toExport = true
  ) {
    let records: GrouparooRecord[] = await api.sequelize.query(
      `
    SELECT "id" from "records" where "state" = 'pending'
    EXCEPT
    SELECT DISTINCT("recordId") FROM "recordProperties" WHERE "state" = 'pending'
    LIMIT ${limit}
    ;
    `,
      {
        type: QueryTypes.SELECT,
        model: GrouparooRecord,
      }
    );

    const updateResponse = await GrouparooRecord.update(
      { state: "ready" },
      {
        where: {
          id: { [Op.in]: records.map((p) => p.id) },
          state: "pending",
        },
      }
    );

    // For postgres only: we can update our result set with the rows that were updated, filtering out those which are no longer state=pending
    // in SQLite this isn't possible, but contention is far less likely
    if (updateResponse[1]) records = updateResponse[1];

    if (records.length === 0) return [];

    await completeRecordImports(
      records.map((p) => p.id),
      toExport
    );

    return records;
  }

  async function completeRecordImports(recordIds: string[], toExport: boolean) {
    const records = await GrouparooRecord.findAll({
      where: {
        id: { [Op.in]: recordIds },
      },
      include: [
        { model: RecordProperty, required: true },
        { model: Import, required: false, where: { recordUpdatedAt: null } },
      ],
    });
    if (records.length === 0) return;

    const memberships = await RecordOps.updateGroupMemberships(records);
    const now = new Date();

    for (const record of records) {
      const imports = record.imports;
      if (imports.length > 0) {
        const newRecordProperties = await record.simplifiedProperties();
        const newGroupIds = Object.keys(memberships[record.id]).filter(
          (groupId) => memberships[record.id][groupId] === true
        );

        await Import.update(
          {
            newRecordProperties: newRecordProperties,
            recordUpdatedAt: now,
            newGroupIds: newGroupIds,
            groupsUpdatedAt: now,
            exportedAt: toExport ? undefined : now, // we want to indicate that the import's lifecycle is complete
          },
          {
            where: { id: { [Op.in]: imports.map((i) => i.id) } },
          }
        );
      }
    }
  }
}

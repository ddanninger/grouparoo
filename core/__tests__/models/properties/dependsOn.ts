import { helper } from "@grouparoo/spec-helper";
import { Property } from "../../../src/models/Property";
import { Source } from "../../../src/models/Source";
import { PropertyOps } from "../../../src/modules/ops/property";

let actionhero;

describe("models/property", () => {
  beforeAll(async () => {
    const env = await helper.prepareForAPITest();
    actionhero = env.actionhero;
  }, helper.setupTime);

  afterAll(async () => {
    await helper.shutdown(actionhero);
  });

  describe("dependsOn", () => {
    /**
     * Source: Users Table (userId -> id)
     *   userID
     *   email
     *
     * Source: Purchases Table (userId -> user_id)
     *   purchasesCount
     *
     * Source: SupportTickets Table (email -> email
     *   supportTicketsCount
     *
     * Source: Queries
     *   emailDomain (requires email)
     */

    let usersTableSource: Source;
    let purchasesTableSource: Source;
    let supportTicketsTableSource: Source;
    let querySource: Source;

    let userIdProperty: Property;
    let emailProperty: Property;
    let purchasesCountProperty: Property;
    let supportTicketsCountProperty: Property;
    let emailDomainProperty: Property;

    beforeAll(async () => {
      usersTableSource = await helper.factories.source();
      await usersTableSource.setOptions({ table: "users" });
      await usersTableSource.bootstrapUniqueProperty("userId", "integer", "id");
      await usersTableSource.setMapping({ id: "userId" });
      await usersTableSource.update({ state: "ready" });

      // bootstrapped
      userIdProperty = await Property.findOne({
        where: { key: "userId" },
      });

      emailProperty = await Property.create({
        key: "email",
        type: "string",
        unique: true,
        sourceGuid: usersTableSource.guid,
      });
      await emailProperty.setOptions({ column: "email" });
      await emailProperty.update({ state: "ready" });

      purchasesTableSource = await helper.factories.source();
      await purchasesTableSource.setOptions({ table: "purchases" });
      await purchasesTableSource.setMapping({ user_id: "userId" });
      await purchasesTableSource.update({ state: "ready" });

      purchasesCountProperty = await Property.create({
        key: "purchases",
        type: "integer",
        unique: false,
        sourceGuid: purchasesTableSource.guid,
      });
      await purchasesCountProperty.setOptions({ column: "purchases" });
      await purchasesCountProperty.update({ state: "ready" });

      supportTicketsTableSource = await helper.factories.source();
      await supportTicketsTableSource.setOptions({ table: "support_tickets" });
      await supportTicketsTableSource.setMapping({ customer_email: "email" });
      await supportTicketsTableSource.update({ state: "ready" });

      supportTicketsCountProperty = await Property.create({
        key: "supportTickets",
        type: "integer",
        unique: false,
        sourceGuid: supportTicketsTableSource.guid,
      });
      await supportTicketsCountProperty.setOptions({
        column: "support_tickets",
      });
      await supportTicketsCountProperty.update({ state: "ready" });

      querySource = await helper.factories.source();
      await querySource.setOptions({ table: "x" }); // we don't have a test quey source...
      await querySource.setMapping({ x: "userId" });
      await querySource.update({ state: "ready" });

      emailDomainProperty = await Property.create({
        key: "emailDomain",
        type: "string",
        unique: false,
        sourceGuid: querySource.guid,
      });
      await emailDomainProperty.setOptions({
        column:
          "select split_part(email, '@', 2) AS domain from users where email = {{ email }}",
      });
      await emailDomainProperty.update({ state: "ready" });
    });

    test("direct mapping rules do not depend on themselves", async () => {
      const dependencies = await PropertyOps.dependencies(userIdProperty);
      expect(dependencies.map((rule) => rule.guid)).toEqual([]);
    });

    test("dependent rules of this source", async () => {
      const dependencies = await PropertyOps.dependencies(emailProperty);
      expect(dependencies.map((rule) => rule.guid)).toEqual([
        userIdProperty.guid,
      ]);
    });

    test("dependent rules for another source", async () => {
      const dependencies = await PropertyOps.dependencies(
        purchasesCountProperty
      );
      expect(dependencies.map((rule) => rule.guid)).toEqual([
        userIdProperty.guid,
      ]);
    });

    test("chained dependent rules for another source", async () => {
      const dependencies = await PropertyOps.dependencies(
        supportTicketsCountProperty
      );
      expect(dependencies.map((rule) => rule.guid)).toEqual([
        emailProperty.guid,
      ]);
    });

    test("mustache variables reference another rule", async () => {
      const dependencies = await PropertyOps.dependencies(emailDomainProperty);
      expect(dependencies.map((rule) => rule.guid)).toEqual([
        userIdProperty.guid, // from the mapping
        emailProperty.guid, // from the mustache rule
      ]);
    });
  });
});
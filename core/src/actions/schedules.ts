import { Schedule } from "../models/Schedule";
import { Run } from "../models/Run";
import { AuthenticatedAction } from "../classes/actions/authenticatedAction";
import { ConfigWriter } from "../modules/configWriter";
import { FilterHelper } from "../modules/filterHelper";
import { APIData } from "../modules/apiData";
import { Op } from "sequelize";

export class SchedulesList extends AuthenticatedAction {
  constructor() {
    super();
    this.name = "schedules:list";
    this.description = "list all the schedules";
    this.outputExample = {};
    this.permission = { topic: "source", mode: "read" };
    this.inputs = {
      limit: { required: true, default: 100, formatter: APIData.ensureNumber },
      offset: { required: true, default: 0, formatter: APIData.ensureNumber },
      state: { required: false },
      order: {
        required: false,
        formatter: APIData.ensureObject,
        default: [
          ["name", "desc"],
          ["createdAt", "desc"],
        ],
      },
    };
  }

  async runWithinTransaction({ params }) {
    const where = {};
    if (params.state) where["state"] = params.state;

    const schedules = await Schedule.scope(null).findAll({
      where,
      limit: params.limit,
      offset: params.offset,
      order: params.order,
    });

    const total = await Schedule.scope(null).count({ where });

    return {
      total,
      schedules: await Promise.all(schedules.map((conn) => conn.apiData())),
    };
  }
}

export class ScheduleRun extends AuthenticatedAction {
  constructor() {
    super();
    this.name = "schedule:run";
    this.description = "run a schedule either importing or exporting data";
    this.outputExample = {};
    this.permission = { topic: "source", mode: "write" };
    this.inputs = {
      id: { required: true },
    };
  }

  async runWithinTransaction({ params }) {
    const schedule = await Schedule.findById(params.id);
    const run = await schedule.enqueueRun();
    return { run: await run.apiData() };
  }
}

export class SchedulesRun extends AuthenticatedAction {
  constructor() {
    super();
    this.name = "schedules:run";
    this.description = "run all schedules";
    this.outputExample = {};
    this.permission = { topic: "source", mode: "write" };
    this.inputs = {
      scheduleIds: { required: false, formatter: APIData.ensureObject },
    };
  }

  async runWithinTransaction({ params }) {
    const runs: Run[] = [];

    const where = {};
    if (params.scheduleIds && params.scheduleIds.length > 0) {
      where["id"] = { [Op.in]: params.scheduleIds };
    }
    const schedules = await Schedule.findAll({ where });

    for (const schedule of schedules) {
      const runningRun = await Run.scope(null).findOne({
        where: {
          state: "running",
          creatorId: schedule.id,
          creatorType: "schedule",
        },
      });

      if (runningRun) await runningRun.stop();

      const newRun = await schedule.enqueueRun();
      runs.push(newRun);
    }

    return { runs: await Promise.all(runs.map((run) => run.apiData())) };
  }
}

export class ScheduleCreate extends AuthenticatedAction {
  constructor() {
    super();
    this.name = "schedule:create";
    this.description = "create a schedule";
    this.outputExample = {};
    this.permission = { topic: "source", mode: "write" };
    this.inputs = {
      name: { required: false },
      sourceId: { required: true },
      recurring: { required: true, formatter: APIData.ensureBoolean },
      confirmRecords: {
        required: false,
        formatter: APIData.ensureBoolean,
      },
      state: { required: false },
      options: { required: false, formatter: APIData.ensureObject },
      recurringFrequency: {
        required: true,
        default: 0,
        formatter: APIData.ensureNumber,
      },
      filters: { required: false, formatter: APIData.ensureObject },
    };
  }

  async runWithinTransaction({ params }) {
    const schedule = await Schedule.create({
      name: params.name,
      sourceId: params.sourceId,
      recurring: params.recurring,
      recurringFrequency: params.recurringFrequency,
      confirmRecords: params.confirmRecords,
    });

    if (params.options) await schedule.setOptions(params.options);
    if (params.filters) await schedule.setFilters(params.filters);
    if (params.state) await schedule.update({ state: params.state });

    await ConfigWriter.run();

    return {
      schedule: await schedule.apiData(),
      pluginOptions: await schedule.pluginOptions(),
    };
  }
}

export class ScheduleEdit extends AuthenticatedAction {
  constructor() {
    super();
    this.name = "schedule:edit";
    this.description = "edit a schedule";
    this.outputExample = {};
    this.permission = { topic: "source", mode: "write" };
    this.inputs = {
      id: { required: true },
      name: { required: false },
      sourceId: { required: false },
      recurring: { required: false, formatter: APIData.ensureBoolean },
      confirmRecords: {
        required: false,
        formatter: APIData.ensureBoolean,
      },
      state: { required: false },
      options: { required: false, formatter: APIData.ensureObject },
      recurringFrequency: { required: false, formatter: APIData.ensureNumber },
      filters: { required: false, formatter: APIData.ensureObject },
    };
  }

  async runWithinTransaction({ params }) {
    const schedule = await Schedule.findById(params.id);
    // these timing options are validated separately, and should be set first
    if (params.recurringFrequency || params.recurring) {
      await schedule.update({
        recurringFrequency: params.recurringFrequency,
        recurring: params.recurring,
      });
    }

    if (params.options) await schedule.setOptions(params.options);
    if (params.filters) await schedule.setFilters(params.filters);

    await schedule.update({
      state: params.state,
      name: params.name,
      confirmRecords: params.confirmRecords,
    });

    await ConfigWriter.run();

    return {
      schedule: await schedule.apiData(),
      pluginOptions: await schedule.pluginOptions(),
    };
  }
}

export class ScheduleFilterOptions extends AuthenticatedAction {
  constructor() {
    super();
    this.name = "schedule:filterOptions";
    this.description = "view a the filter options for a schedule";
    this.outputExample = {};
    this.permission = { topic: "source", mode: "read" };
    this.inputs = {
      id: { required: true },
    };
  }

  async runWithinTransaction({ params }) {
    const schedule = await Schedule.findById(params.id);
    return { options: await FilterHelper.pluginFilterOptions(schedule) };
  }
}

export class ScheduleView extends AuthenticatedAction {
  constructor() {
    super();
    this.name = "schedule:view";
    this.description = "view a schedule";
    this.outputExample = {};
    this.permission = { topic: "source", mode: "read" };
    this.inputs = {
      id: { required: true },
    };
  }

  async runWithinTransaction({ params }) {
    const schedule = await Schedule.findById(params.id);
    return {
      schedule: await schedule.apiData(),
      pluginOptions: await schedule.pluginOptions(),
    };
  }
}

export class ScheduleDestroy extends AuthenticatedAction {
  constructor() {
    super();
    this.name = "schedule:destroy";
    this.description = "destroy a schedule";
    this.outputExample = {};
    this.permission = { topic: "source", mode: "write" };
    this.inputs = {
      id: { required: true },
    };
  }

  async runWithinTransaction({ params }) {
    const schedule = await Schedule.findById(params.id);
    await schedule.destroy();
    await ConfigWriter.run();
    return { success: true };
  }
}

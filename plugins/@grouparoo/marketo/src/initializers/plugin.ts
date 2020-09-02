import { Initializer } from "actionhero";
import { plugin } from "@grouparoo/core";

import { test } from "./../lib/test";
import { parallelism } from "./../lib/parallelism";

import { exportProfiles } from "../lib/export/exportProfiles";
import { destinationOptions } from "../lib/export/destinationOptions";
import { destinationMappingOptions } from "../lib/export/destinationMappingOptions";
import { exportArrayProperties } from "../lib/export/exportArrayProperties";

const packageJSON = require("./../../package.json");

export class Plugins extends Initializer {
  constructor() {
    super();
    this.name = packageJSON.name;
  }

  async initialize() {
    plugin.registerPlugin({
      name: packageJSON.name,
      icon: "/public/@grouparoo/marketo/marketo.png",
      apps: [
        {
          name: "marketo",
          options: [
            {
              key: "endpoint",
              required: true,
              description:
                "in Web Services - i.e. https://123-ABC-456.mktorest.com/rest",
            },
            {
              key: "identity",
              required: true,
              description:
                "in Web Services - i.e. https://123-ABC-456.mktorest.com/identity",
            },
            {
              key: "clientId",
              required: true,
              description: "in LaunchPoint for an API user",
            },
            {
              key: "clientSecret",
              required: true,
              description: "in LaunchPoint for an API user",
            },
          ],
          methods: { test, parallelism },
        },
      ],
      connections: [
        {
          name: "marketo-export",
          direction: "export",
          description: "export profiles to a marketo account",
          app: "marketo",
          options: [],
          methods: {
            exportProfiles,
            destinationOptions,
            destinationMappingOptions,
            exportArrayProperties,
          },
        },
      ],
    });
  }

  async start() {
    plugin.mountModels();
  }
}
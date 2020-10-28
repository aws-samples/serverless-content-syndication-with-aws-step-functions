#!/usr/bin/env node
/* tslint:disable:no-unused-expression no-submodule-imports no-import-side-effect */
import * as cdk from "@aws-cdk/core";
import "source-map-support/register";

import { SyndicationWorkflow } from "../lib/syndication-workflow";

const app = new cdk.App();

const config = {
    MediaConvertEndpointURL: "",
    BucketPrefix: ""
}

if (config.MediaConvertEndpointURL === "" || config.BucketPrefix === "") {
    throw new Error("Parameter missing in stack config - Check README");
}

new SyndicationWorkflow(app, "ServerlessSyndication", config);

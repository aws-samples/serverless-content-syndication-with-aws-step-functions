#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import "source-map-support/register";

import { SyndicationWorkflow } from "../lib/syndication-workflow";

const app = new cdk.App();

const config = {
    MediaConvertEndpointURL: process.env.MEDIACONVERT_ENDPOINT_URL || "",
    BucketPrefix: process.env.BUCKET_PREFIX || ""
}

if (config.MediaConvertEndpointURL === "" || config.BucketPrefix === "") {
    throw new Error("Parameter missing in stack config - Check README");
}

new SyndicationWorkflow(app, "ServerlessSyndication", config);

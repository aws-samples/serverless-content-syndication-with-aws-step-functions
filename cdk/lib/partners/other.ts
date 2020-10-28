/* tslint:disable:no-submodule-imports */
import * as s3 from "@aws-cdk/aws-s3";
import {Choice, Condition, Parallel, Pass, Result} from "@aws-cdk/aws-stepfunctions";
import {State} from "@aws-cdk/aws-stepfunctions/lib/states/state";
import {Construct, Resource} from "@aws-cdk/core";

import {Util} from "../util";

export class OtherPartnerResources extends Resource {
    public readonly workflowDefinition: State;
    private readonly providerIdentifier: string = "OtherProvider";

    constructor(scope: Construct, id: string, sourceBucket: s3.Bucket) {
        super(scope, id);
        this.workflowDefinition = this.createWorkflow();
    }

    private isProviderEnabled() {
        return Condition.booleanEquals(`$.Destinations.${this.providerIdentifier}`, true);
    }

    private createWorkflow(): Choice {
        const OtherPartner = {
            NoAction: new Pass(this, `${this.providerIdentifier}-NotEntitled`, {
                result: Result.fromObject({
                    Provider: "Other",
                    Status: "IGNORED"
                })
            }),
            Images: Util.makeLambdaInvokeTaskFromJSFunction(this, "provider-other", "ProcessImageOther", `${this.providerIdentifier}-Image`),
            Metadata: Util.makeLambdaInvokeTaskFromJSFunction(this, "provider-other", "ProcessMetadataOther", `${this.providerIdentifier}-Metadata`),
            Video: Util.makeLambdaInvokeTaskFromJSFunction(this, "provider-other", "ProcessVideoOther", `${this.providerIdentifier}-Video`),
            Verification: Util.makeLambdaInvokeTaskFromJSFunction(this, "provider-other", "PostprocessOther", `${this.providerIdentifier}-Postprocess`)
        };

        const ProviderOtherParallelProcessing = new Parallel(this, `${this.providerIdentifier}-ParallelSteps`)
            .branch(OtherPartner.Images, OtherPartner.Metadata, OtherPartner.Video)
            .next(OtherPartner.Verification);

        return new Choice(this, this.providerIdentifier)
            .when(this.isProviderEnabled(), ProviderOtherParallelProcessing)
            .otherwise(OtherPartner.NoAction);
    }
}

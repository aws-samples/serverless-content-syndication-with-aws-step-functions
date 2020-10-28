import * as events from "@aws-cdk/aws-events";
import * as eventtargets from "@aws-cdk/aws-events-targets";
import * as iam from "@aws-cdk/aws-iam";
import * as lambda from "@aws-cdk/aws-lambda";
import * as s3 from "@aws-cdk/aws-s3";
import * as s3notifications from "@aws-cdk/aws-s3-notifications";
import * as sfn from "@aws-cdk/aws-stepfunctions";
import * as cdk from "@aws-cdk/core";
import * as path from "path";

import {AceResources} from "./partners/ACE";
import {OtherPartnerResources} from "./partners/other";
import {Util} from "./util";

interface SyndicationStackProps extends cdk.StackProps {
    MediaConvertEndpointURL: string;
    BucketPrefix: string;
}

export class SyndicationWorkflow extends cdk.Stack {
    private readonly mediaConvertEndpointURL: string;
    private readonly partnerACEDestinationBucketName: string;
    private readonly sourceBucket: s3.Bucket;

    constructor(scope: cdk.Construct, id: string, props: SyndicationStackProps) {
        super(scope, id, props);
        this.mediaConvertEndpointURL = props.MediaConvertEndpointURL;
        this.partnerACEDestinationBucketName = `${props.BucketPrefix}.partner.ace`;

        this.sourceBucket = new s3.Bucket(this, "SourceFiles", {
            bucketName: `${props.BucketPrefix}.source`
        });

        const stateMachine: sfn.StateMachine = this.createStateMachine();

        this.setupLambdaForS3Events(stateMachine);
        this.setupLambdaToHandleFinishedTranscoding(stateMachine);
    }

    /**
     * Creates the state machine, lambda functions and tasks
     * @private
     */
    private createStateMachine() {
        const Ace = new AceResources(this, "AceResources", this.sourceBucket, this.partnerACEDestinationBucketName, this.mediaConvertEndpointURL);
        const OtherProvider = new OtherPartnerResources(this, "OtherPartner", this.sourceBucket);

        const CheckPartnerEntitlement = Util.makeLambdaInvokeTaskFromJSFunction(this, "shared", "CheckPartnerEntitlement");
        const ReportResult = Util.makeLambdaInvokeTaskFromJSFunction(this, "shared", "ReportResult");

        const ParallelPartnerWorkflowProcessing = new sfn.Parallel(this, "ParallelPartnerProcessing")
            .branch(
                Ace.workflowDefinition,
                OtherProvider.workflowDefinition
            );

        const SyndicationWorkflowDefinition = CheckPartnerEntitlement
            .next(ParallelPartnerWorkflowProcessing)
            .next(ReportResult);

        return new sfn.StateMachine(this, "SyndicationStateMachine", {
            definition: SyndicationWorkflowDefinition,
            timeout: cdk.Duration.minutes(60),
            stateMachineName: "Syndication"
        });
    }
    /**
     * Create a Lambda function to handle s3 uploads and sets the required permission to read from S3 and trigger the execution of a state machine
     * @param stateMachine
     * @private
     */
    private setupLambdaForS3Events(stateMachine: sfn.StateMachine) {
        const objectCreatedLambdaHandler = new lambda.Function(this, "FileUploadLambda", {
            runtime: lambda.Runtime.NODEJS_12_X,
            handler: "shared.ProcessUploadToSourceBucket",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "..", "src", "handlers")),
            environment: {
                STATE_MACHINE_ARN: stateMachine.stateMachineArn
            }
        });

        objectCreatedLambdaHandler.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["states:StartExecution"],
            resources: [stateMachine.stateMachineArn]
        }));

        this.sourceBucket.addObjectCreatedNotification(new s3notifications.LambdaDestination(objectCreatedLambdaHandler));
        this.sourceBucket.grantRead(objectCreatedLambdaHandler);
    }

    /**
     * Sets up a Lambda that reacts to a "MediaConvert Job State Change" event and reports back to the state machine via the send-task-success API call. This will trigger the state machine to reassume processing
     * @param stateMachine
     * @private
     */
    private setupLambdaToHandleFinishedTranscoding(stateMachine: sfn.StateMachine) {
        const transcodingFinishedLambda = Util.makeLambdaFromJSFunction(this, "shared", "HandleFinishedTranscoding");
        const eventsRule = new events.Rule(this, "TranscodingFinished", {
            ruleName: "MediaConvertForSyndicationFinished",
            eventPattern: {
                source: ["aws.mediaconvert"],
                detailType: ["MediaConvert Job State Change"]
            },
            targets: [new eventtargets.LambdaFunction(transcodingFinishedLambda)]
        });

        transcodingFinishedLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["states:SendTask*"],
            resources: [stateMachine.stateMachineArn]
        }));
    }

}

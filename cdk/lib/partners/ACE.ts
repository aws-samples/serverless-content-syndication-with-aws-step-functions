/* tslint:disable:no-submodule-imports */
import * as iam from "@aws-cdk/aws-iam";
import * as lambda from "@aws-cdk/aws-lambda";
import {CfnJobTemplate, CfnQueue} from "@aws-cdk/aws-mediaconvert";
import * as s3 from "@aws-cdk/aws-s3";
import {
    Choice,
    Condition,
    IntegrationPattern,
    JsonPath,
    Parallel,
    Pass,
    Result,
    TaskInput
} from "@aws-cdk/aws-stepfunctions";
import * as tasks from "@aws-cdk/aws-stepfunctions-tasks";
import { State } from "@aws-cdk/aws-stepfunctions/lib/states/state";
import {Construct, Duration, Resource} from "@aws-cdk/core";
import * as path from "path";

export class AceResources extends Resource {
    public readonly workflowDefinition: State;
    private readonly sourceBucket: s3.Bucket;
    private readonly destinationBucket: s3.Bucket;
    private readonly providerIdentifier: string = "ACE";
    private readonly mediaConvertEndpointURL: string;

    constructor(scope: Construct, id: string, sourceBucket: s3.Bucket, destinationBucketName: string, mediaConvertEndpointUrl: string) {
        super(scope, id);

        this.mediaConvertEndpointURL = mediaConvertEndpointUrl;
        this.sourceBucket = sourceBucket;
        this.destinationBucket = new s3.Bucket(this, `${this.providerIdentifier}OutputBucket`, {
            bucketName: destinationBucketName
        });

        this.workflowDefinition = this.createWorkflow();
    }

    private isProviderEnabled() {
        return Condition.booleanEquals(`$.Destinations.${this.providerIdentifier}`, true);
    }

    /**
     * Creates the workflow required to handle delivery for partner ACE
     * @private
     */
    private createWorkflow(): Choice {
        const lambdaDependencies = new lambda.LayerVersion(this, "LambdaLayer", {
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "..", "..", "src", "lib")),
            compatibleRuntimes: [lambda.Runtime.NODEJS_12_X],
            description: `Dependencies required to process files for Partner: ${this.providerIdentifier}`,
            license: "Apache-2.0",
        });

        const NoAction = new Pass(this, `${this.providerIdentifier}-NotEntitled`, {
            result: Result.fromObject({
                Provider: this.providerIdentifier,
                Status: "IGNORED"
            })
        });

        const ImageProcessing = this.createImageProcessingTaskAndRequiredResources(lambdaDependencies);
        const MetadataProcessing = this.createMetadataProcessingTaskAndRequiredResources(lambdaDependencies);
        const VideoProcessing = this.createVideoConvertTaskAndRequiredResources(lambdaDependencies);
        const Postprocessing = this.createPostProcessingTask(lambdaDependencies);

        const ProviderACEParallelProcessing = new Parallel(this, `${this.providerIdentifier}-ParallelSteps`)
            .branch(ImageProcessing, MetadataProcessing, VideoProcessing)
            .next(Postprocessing);

        return new Choice(this, this.providerIdentifier)
            .when(this.isProviderEnabled(), ProviderACEParallelProcessing)
            .otherwise(NoAction);
    }

    /**
     * Creates the resources required to transcode videos as part of the state machine. Sets up permissions and MediaConvert configuration
     * @param dependenices
     * @private
     */
    private createVideoConvertTaskAndRequiredResources(dependenices: lambda.LayerVersion) {
        const mediaConvertRole = new iam.Role(this, "MediaConvertRole", {
            roleName: "MediaConvertRole",
            assumedBy: new iam.ServicePrincipal("mediaconvert.amazonaws.com")
        });

        mediaConvertRole.addToPolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["s3:*"],
                resources: [
                    this.sourceBucket.bucketArn, `${this.sourceBucket.bucketArn}/*`,
                    this.destinationBucket.bucketArn, `${this.destinationBucket.bucketArn}/*`
                ]
            })
        );

        const mediaConvertQueue = new CfnQueue(this, "MediaConvertQueue", {
            name: "SyndicationQueue",
            pricingPlan: "ON_DEMAND",
            status: "ACTIVE"
        });

        const jobTemplate = new CfnJobTemplate(this, "TranscodingJobTemplate", {
            description: `Job Template to transcode videos for Partner ${this.providerIdentifier}`,
            category: "GENERIC",
            name: `${this.providerIdentifier}-TranscodingJobTemplate`,
            settingsJson: {
                OutputGroups: [
                    {
                        Name: "File Group",
                        Outputs: [
                            {
                                Preset: "System-Generic_Hd_Mp4_Hev1_Aac_16x9_Sdr_1280x720p_30Hz_4Mbps_Qvbr_Vq9",
                                Extension: "mp4",
                                NameModifier: "_720p"
                            }
                        ],
                        OutputGroupSettings: {
                            Type: "FILE_GROUP_SETTINGS",
                            FileGroupSettings: {}
                        }
                    }
                ]
            },
            statusUpdateInterval: "SECONDS_10",
        });

        const videoLambda = new lambda.Function(this, "VideoLambdaFunction", {
            runtime: lambda.Runtime.NODEJS_12_X,
            timeout: Duration.seconds(30),
            handler: "provider-ace.ProcessVideos",
            layers: [dependenices],
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "..", "..", "src", "handlers")),
            environment: {
                JOB_TEMPLATE_NAME: jobTemplate.attrName,
                OUTPUT_BUCKET_NAME: this.destinationBucket.bucketName,
                MEDIA_CONVERT_ROLE_ARN: mediaConvertRole.roleArn,
                MEDIA_CONVERT_QUEUE_ARN: mediaConvertQueue.attrArn,
                MEDIA_CONVERT_ENDPOINT_URL: this.mediaConvertEndpointURL,
            }
        });

        const videoLambdaTask = new tasks.LambdaInvoke(this, `${this.providerIdentifier}-Video`, {
            lambdaFunction: videoLambda,
            payload: TaskInput.fromObject({
                "token": JsonPath.taskToken,
                "bucketName.$": "$.Video.bucketName",
                "objectKey.$": "$.Video.objectKey",
                "assetId.$": "$.AssetId"
            }),
            integrationPattern: IntegrationPattern.WAIT_FOR_TASK_TOKEN
        });

        videoLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["iam:PassRole"],
            resources: [mediaConvertRole.roleArn]
        }));

        videoLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["mediaconvert:CreateJob"],
            resources: [mediaConvertQueue.attrArn, jobTemplate.attrArn]
        }));

        videoLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["mediaconvert:DescribeEndpoints"],
            resources: ["*"]
        }));

        return videoLambdaTask;
    }

    private createImageProcessingTaskAndRequiredResources(lambdaDependencies: lambda.LayerVersion) {
        const imageProcessingLambda = new lambda.Function(this, "ImageLambdaFunction", {
            runtime: lambda.Runtime.NODEJS_12_X,
            handler: "provider-ace.ProcessImages",
            layers: [lambdaDependencies],
            memorySize: 1024,
            timeout: Duration.minutes(2),
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "..", "..", "src", "handlers")),
            environment: {
                OUTPUT_BUCKET_NAME: this.destinationBucket.bucketName,
            }
        });

        const imageProcessingTask = new tasks.LambdaInvoke(this, `${this.providerIdentifier}-Image`, {
            lambdaFunction: imageProcessingLambda,
            payloadResponseOnly: true,
            payload: TaskInput.fromObject({
                "bucketName.$": "$.Image.bucketName",
                "objectKey.$": "$.Image.objectKey",
                "assetId.$": "$.AssetId"
            })
        });

        this.sourceBucket.grantRead(imageProcessingLambda);
        this.destinationBucket.grantReadWrite(imageProcessingLambda);

        return imageProcessingTask;
    }

    private createPostProcessingTask(lambdaDependencies: lambda.LayerVersion) {
        const postprocessLambda = new lambda.Function(this, "PostprocessLambdaFunction", {
            runtime: lambda.Runtime.NODEJS_12_X,
            handler: "provider-ace.PostProcessOutput",
            layers: [lambdaDependencies],
            timeout: Duration.seconds(30),
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "..", "..", "src", "handlers")),
        });

        const postprocessTask = new tasks.LambdaInvoke(this, `${this.providerIdentifier}-Postprocess`, {
            lambdaFunction: postprocessLambda,
            payloadResponseOnly: true
        });

        this.destinationBucket.grantRead(postprocessLambda);

        return postprocessTask;
    }

    private createMetadataProcessingTaskAndRequiredResources(lambdaDependencies: lambda.LayerVersion) {
        const metadataProcessingLambda = new lambda.Function(this, "MetadataLambdaFunction", {
            runtime: lambda.Runtime.NODEJS_12_X,
            handler: "provider-ace.ProcessMetadata",
            layers: [lambdaDependencies],
            timeout: Duration.minutes(2),
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "..", "..", "src", "handlers")),
            environment: {
                OUTPUT_BUCKET_NAME: this.destinationBucket.bucketName,
            }
        });

        const metadataProcessingTask = new tasks.LambdaInvoke(this, `${this.providerIdentifier}-Metadata`, {
            lambdaFunction: metadataProcessingLambda,
            payloadResponseOnly: true,
            payload: TaskInput.fromObject({
                "bucketName.$": "$.Metadata.bucketName",
                "objectKey.$": "$.Metadata.objectKey",
                "assetId.$": "$.AssetId"
            })
        });

        this.sourceBucket.grantRead(metadataProcessingLambda);
        this.destinationBucket.grantReadWrite(metadataProcessingLambda);

        return metadataProcessingTask;
    }
}

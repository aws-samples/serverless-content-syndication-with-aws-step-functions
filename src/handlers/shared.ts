import { EventBridgeEvent, S3CreateEvent } from "aws-lambda";
import * as AWS from "aws-sdk";

const StepFunctions = new AWS.StepFunctions({apiVersion: "latest"});
const S3 = new AWS.S3({apiVersion: "latest"});

export interface ProcessingStepResult {
    AssetId: string;
    Bucket: string;
    Key: string;
    Type: string;
}

export interface PartnerResult {
    Output?: any;
    Provider: string;
    Status: string;
}

export async function CheckPartnerEntitlement(event: any) {
    event.Destinations = {
        ACE: true,
        OtherProvider: false
    };

    return event;
}

export async function ProcessUploadToSourceBucket(event: S3CreateEvent) {
    const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;

    interface Manifest {
        Video: string;
        Image: string;
        Metadata: string;
    }

    for (const record of event.Records) {
        const pathParts = record.s3.object.key.split("/");
        const folder = pathParts.slice(0, pathParts.length - 1).join("/");
        const manifestPath = `${folder}/manifest.json`;

        const objects = await S3.listObjects({
            Bucket: record.s3.bucket.name,
            Prefix: folder
        }).promise();

        const keysInFolder = objects.Contents!.map((content) => content.Key);

        if (keysInFolder.indexOf(manifestPath) < 0) {
            console.log("Manifest not found.");
            return;
        }

        const manifestObj = await S3.getObject({
            Bucket: record.s3.bucket.name,
            Key: manifestPath
        }).promise();

        const manifest: Manifest = JSON.parse(manifestObj.Body!.toString());

        const folderContainsVideo = keysInFolder.indexOf(`${folder}/${manifest.Video}`) > -1;
        const folderContainsImage = keysInFolder.indexOf(`${folder}/${manifest.Image}`) > -1;
        const folderContainsMetadata = keysInFolder.indexOf(`${folder}/${manifest.Metadata}`) > -1;

        if (folderContainsVideo && folderContainsImage && folderContainsMetadata) {
            console.log("Manifest and files found. Starting State Machine");
            const stepFunctionExecutionResult = await StepFunctions.startExecution({
                input: JSON.stringify({
                    AssetId: folder,
                    Image: {
                        bucketName: record.s3.bucket.name,
                        objectKey: `${folder}/${manifest.Image}`
                    },
                    Metadata: {
                        bucketName: record.s3.bucket.name,
                        objectKey: `${folder}/${manifest.Metadata}`
                    },
                    Video: {
                        bucketName: record.s3.bucket.name,
                        objectKey: `${folder}/${manifest.Video}`
                    },
                }),
                name: `S3UploadTriggeredExecution${Date.now()}`,
                stateMachineArn: STATE_MACHINE_ARN
            }).promise();

            console.log(stepFunctionExecutionResult);
        } else {
            console.log("Files required by Manifest are missing");
        }
    }

    return;
}

export async function HandleFinishedTranscoding(event: EventBridgeEvent<"MediaConvert Job State Change", any>) {
    const userMetaData = event.detail.userMetadata;
    // https://docs.aws.amazon.com/mediaconvert/latest/ug/user-metadata-tags.html
    const token = `${userMetaData.StepFunctionTaskToken1!}${userMetaData.StepFunctionTaskToken2!}${userMetaData.StepFunctionTaskToken3!}`;

    if (event.detail.status === "COMPLETE") {
        await StepFunctions.sendTaskSuccess({
            output: JSON.stringify({
                AssetId: userMetaData.AssetId,
                Bucket: userMetaData.Bucket,
                // tslint:disable-next-line:max-line-length
                // MediaConvert adds a suffix to the output to allow for multiple outputs in the same location (i.e. _720p, _1080p, ..)
                // We get the actual filename from the output details
                Key: event.detail.outputGroupDetails[0].outputDetails[0].outputFilePaths[0].replace(`s3://${userMetaData.Bucket}/`, ""),
                Type: "Video"
            }),
            taskToken: token
        }).promise();
    }

    if (event.detail.status === "STATUS_UPDATE" || event.detail.status === "PROGRESSING") {
        await StepFunctions.sendTaskHeartbeat({
            taskToken: token
        }).promise();
    }

    if (event.detail.status === "ERROR" || event.detail.status === "CANCELED") {
        await StepFunctions.sendTaskFailure({
            error: event.detail.errorMessage,
            taskToken: token
        }).promise();
    }

    return;
}

export async function ReportResult(event: any) {
    console.log("OK");
    /**
     * Use this to act on the results of the statemachine, i.e by notifying partners or updating some database
     */
    return;
}

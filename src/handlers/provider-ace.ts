// TypeScript import causes Jimp to be undefined

import * as AWS from "aws-sdk";
import { GetObjectOutput } from "aws-sdk/clients/s3";
import * as crypto from "crypto";

import { PartnerResult, ProcessingStepResult } from "./shared";

const Jimp = require("jimp-compact");
const convert = require("xml-js");

const OUTPUT_BUCKET_NAME = process.env.OUTPUT_BUCKET_NAME!;
const JOB_TEMPLATE_NAME = process.env.JOB_TEMPLATE_NAME!;
const MEDIA_CONVERT_ENDPOINT_URL = process.env.MEDIA_CONVERT_ENDPOINT_URL!;
const MEDIA_CONVERT_ROLE_ARN = process.env.MEDIA_CONVERT_ROLE_ARN!;
const MEDIA_CONVERT_QUEUE_ARN = process.env.MEDIA_CONVERT_QUEUE_ARN!;

AWS.config.mediaconvert = {endpoint: MEDIA_CONVERT_ENDPOINT_URL};

const MediaConvert = new AWS.MediaConvert({apiVersion: "2017-08-29"});
const S3 = new AWS.S3({apiVersion: "latest"});

export async function ProcessMetadata(event: any): Promise<ProcessingStepResult> {
    const metadataObj = await S3.getObject({
        Bucket: event.bucketName,
        Key: event.objectKey
    }).promise();

    const metadata = JSON.parse(metadataObj.Body!.toString());
    const options = {compact: true, ignoreComment: true, spaces: 4};
    const result = convert.json2xml(metadata, options);

    const destinationKey = `${event.assetId}/metadata.xml`;
    await S3.putObject({
        Body: result,
        Bucket: OUTPUT_BUCKET_NAME,
        Key: destinationKey
    }).promise();

    return {
        AssetId: event.assetId,
        Bucket: OUTPUT_BUCKET_NAME,
        Key: destinationKey,
        Type: "Metadata"
    };
}

export async function ProcessImages(event: any): Promise<ProcessingStepResult>  {
    const imageObj = await S3.getObject({
        Bucket: event.bucketName,
        Key: event.objectKey
    }).promise();

    const buff: Buffer = imageObj.Body as Buffer;
    const image = await Jimp.read(buff);
    const awsLogo = await Jimp.read("http://awsmedia.s3.amazonaws.com/AWS_Logo_PoweredBy_127px.png");

    const padding = 10;
    image.greyscale();
    image.composite(awsLogo, padding, image.bitmap.height - awsLogo.bitmap.height - padding);

    const imageBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);

    await S3.putObject({
        Body: imageBuffer,
        Bucket: OUTPUT_BUCKET_NAME,
        Key: event.objectKey
    }).promise();

    return {
        AssetId: event.assetId,
        Bucket: OUTPUT_BUCKET_NAME,
        Key: event.objectKey,
        Type: "Image"
    };
}

export async function ProcessVideos(event: any) {
    const s3Path = `s3://${event.bucketName}/${event.objectKey}`;

    const input: AWS.MediaConvert.Types.Input = {
        AudioSelectors: {
            "Audio Selector 1": {
                DefaultSelection: "NOT_DEFAULT",
                Offset: 0,
                ProgramSelection: 1,
                SelectorType: "TRACK",
                Tracks: [
                    1
                ]
            }
        },
        FileInput: s3Path,
        PsiControl: "USE_PSI"
    };

    const maxSize = 256;
    const params: AWS.MediaConvert.Types.CreateJobRequest = {
        JobTemplate: JOB_TEMPLATE_NAME,
        Queue: MEDIA_CONVERT_QUEUE_ARN,
        Role: MEDIA_CONVERT_ROLE_ARN,
        Settings: {
            Inputs: [input],
            OutputGroups: [
                {
                    Name: "File Group",
                    OutputGroupSettings: {
                        FileGroupSettings: {
                            Destination: `s3://${OUTPUT_BUCKET_NAME}/${event.assetId}/`
                        },
                        Type: "FILE_GROUP_SETTINGS"
                    }
                }
            ]
        },
        UserMetadata: {
            AssetId: event.assetId,
            Bucket: OUTPUT_BUCKET_NAME,
            Key: event.objectKey,
            // UserMetadata is limited to 256 chars per field, but task token is 640 chars long
            // https://docs.aws.amazon.com/mediaconvert/latest/ug/user-metadata-tags.html
            StepFunctionTaskToken1: event.token.slice(0, maxSize),
            StepFunctionTaskToken2: event.token.slice(maxSize, maxSize * 2),
            StepFunctionTaskToken3: event.token.slice(maxSize * 2, maxSize * 3)
        }
    };

    const createJobAPIResponse = await MediaConvert
        .createJob(params)
        .promise();

    return {
        Job: {
            Id: createJobAPIResponse.Job?.Id,
            Timing: createJobAPIResponse.Job?.Timing
        }
    };
}

export async function PostProcessOutput(event: ProcessingStepResult[]): Promise<PartnerResult> {
    /**
     * Some postprocessing logic, i.e. calculating hashes
     */

    const objetsFromS3 = await Promise.all(event.map((ev) => S3.getObject({
        Bucket: ev.Bucket,
        Key: ev.Key
    }).promise() as GetObjectOutput));

    const checksums = objetsFromS3
        .map((obj) => obj.Body as string)
        .map((body) => crypto.createHash("md5").update(body, "utf8").digest("hex"));

    return {
        Output: {
            Bucket: event[0].Bucket,
            Checksums: checksums,
            Files: event.map((ev) => ev.Key)
        },
        Provider: "ACE",
        Status: "PROCESS_OK"
    };
}

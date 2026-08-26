// TypeScript import causes Jimp to be undefined

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
    CreateJobCommand,
    CreateJobCommandInput,
    Input,
    MediaConvertClient
} from "@aws-sdk/client-mediaconvert";
import * as crypto from "crypto";

import { PartnerResult, ProcessingStepResult } from "./shared";

const Jimp = require("jimp-compact");
const convert = require("xml-js");

const OUTPUT_BUCKET_NAME = process.env.OUTPUT_BUCKET_NAME!;
const JOB_TEMPLATE_NAME = process.env.JOB_TEMPLATE_NAME!;
const MEDIA_CONVERT_ENDPOINT_URL = process.env.MEDIA_CONVERT_ENDPOINT_URL!;
const MEDIA_CONVERT_ROLE_ARN = process.env.MEDIA_CONVERT_ROLE_ARN!;
const MEDIA_CONVERT_QUEUE_ARN = process.env.MEDIA_CONVERT_QUEUE_ARN!;

const MediaConvert = new MediaConvertClient({ endpoint: MEDIA_CONVERT_ENDPOINT_URL });
const S3 = new S3Client({});

export async function ProcessMetadata(event: any): Promise<ProcessingStepResult> {
    const metadataObj = await S3.send(new GetObjectCommand({
        Bucket: event.bucketName,
        Key: event.objectKey
    }));

    const metadata = JSON.parse(await metadataObj.Body!.transformToString());
    const options = {compact: true, ignoreComment: true, spaces: 4};
    const result = convert.json2xml(metadata, options);

    const destinationKey = `${event.assetId}/metadata.xml`;
    await S3.send(new PutObjectCommand({
        Body: result,
        Bucket: OUTPUT_BUCKET_NAME,
        Key: destinationKey
    }));

    return {
        AssetId: event.assetId,
        Bucket: OUTPUT_BUCKET_NAME,
        Key: destinationKey,
        Type: "Metadata"
    };
}

export async function ProcessImages(event: any): Promise<ProcessingStepResult>  {
    const imageObj = await S3.send(new GetObjectCommand({
        Bucket: event.bucketName,
        Key: event.objectKey
    }));

    const buff: Buffer = Buffer.from(await imageObj.Body!.transformToByteArray());
    const image = await Jimp.read(buff);

    const padding = 10;
    image.greyscale();

    // Stamp a text watermark in the bottom-left corner. The watermark is rendered
    // from a font bundled with jimp-compact, which keeps the sample self-contained
    // and avoids depending on an external logo asset that can disappear over time.
    const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    const watermark = "Powered by AWS";
    const textHeight = Jimp.measureTextHeight(font, watermark, image.bitmap.width);
    image.print(font, padding, image.bitmap.height - textHeight - padding, watermark);

    const imageBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);

    await S3.send(new PutObjectCommand({
        Body: imageBuffer,
        Bucket: OUTPUT_BUCKET_NAME,
        Key: event.objectKey
    }));

    return {
        AssetId: event.assetId,
        Bucket: OUTPUT_BUCKET_NAME,
        Key: event.objectKey,
        Type: "Image"
    };
}

export async function ProcessVideos(event: any) {
    const s3Path = `s3://${event.bucketName}/${event.objectKey}`;

    const input: Input = {
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
    const params: CreateJobCommandInput = {
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

    const createJobAPIResponse = await MediaConvert.send(new CreateJobCommand(params));

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

    const objetsFromS3 = await Promise.all(event.map((ev) => S3.send(new GetObjectCommand({
        Bucket: ev.Bucket,
        Key: ev.Key
    }))));

    const objectBodies = await Promise.all(objetsFromS3.map((obj) => obj.Body!.transformToByteArray()));

    const checksums = objectBodies
        .map((body) => crypto.createHash("md5").update(Buffer.from(body)).digest("hex"));

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

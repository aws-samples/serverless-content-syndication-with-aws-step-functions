import {PartnerResult, ProcessingStepResult} from "./shared";

export async function Image(event: any): Promise<ProcessingStepResult> {
    // Logic for Provider B Images
    return {
        AssetId: "",
        Bucket: "",
        Key: "",
        Type: "Image"
    };
}

export async function Metadata(event: any): Promise<ProcessingStepResult> {
    // Logic for Provider B Metadata
    return {
        AssetId: "",
        Bucket: "",
        Key: "",
        Type: "Metadata"
    };
}

export async function Video(event: any): Promise<ProcessingStepResult> {
    // Logic for Provider B Video
    return {
        AssetId: "",
        Bucket: "",
        Key: "",
        Type: "Video"
    };
}

export async function Postprocess(event: ProcessingStepResult[]): Promise<PartnerResult> {
    // Logic for Provider B Output Postprocessing
    return {
        Output: {},
        Provider: "OtherProvider",
        Status: "PROCESS_OK"
    };
}

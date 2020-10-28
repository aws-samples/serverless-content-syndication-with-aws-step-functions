import * as lambda from "@aws-cdk/aws-lambda";
import * as tasks from "@aws-cdk/aws-stepfunctions-tasks";
import * as cdk from "@aws-cdk/core";
import * as path from "path";

export class Util {
    /**
     * Helper function to instantiate a lambda.Function object with default parameters
     * @private
     * @param scope
     * @param handlerFile The .ts file in handlers that contains the function name
     * @param functionName The function name that is called
     */
    public static makeLambdaFromJSFunction(scope: cdk.Construct, handlerFile: string, functionName: string): lambda.Function {
        return new lambda.Function(scope, `${functionName}Lambda`, {
            runtime: lambda.Runtime.NODEJS_12_X,
            handler: `${handlerFile}.${functionName}`,
            tracing: lambda.Tracing.ACTIVE,
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "..", "src", "handlers"))
        });
    }

    /**
     * Helper function to instantiate a tasks.LambdaInvoke object that can be used StepFunction state machines. Used default settings and calls makeLambdaFromJSFunction(functionName) to create the actual lambda.Function
     * @param scope
     * @param handlerFile The .ts file in handlers that contains the function name
     * @param functionName The name of the javascript function that contains your code, will be passed on as argument to makeLambdaFromJSFunction(..)
     * @param id The id for the CDK resource. This will also be the name of the Step in State Functions. Defaults to the function name
     * @private
     */
    public static makeLambdaInvokeTaskFromJSFunction(scope: cdk.Construct, handlerFile: string, functionName: string, id: string = functionName) {
        return new tasks.LambdaInvoke(scope, `${id}`, {
            lambdaFunction: Util.makeLambdaFromJSFunction(scope, handlerFile, functionName),
            outputPath: "$.Payload"
        });
    }
}

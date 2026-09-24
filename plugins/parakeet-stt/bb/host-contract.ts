import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_aiServicesHostContract } from "@get-bb/plugin-sdk/ai-services";
import { configureContract } from "./configure-contract.ts";

export const hostContract = defineRpcContract({ ...experimental_aiServicesHostContract, ...configureContract });

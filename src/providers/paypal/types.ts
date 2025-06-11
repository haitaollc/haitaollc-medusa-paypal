import { ProviderWebhookPayload } from "@medusajs/framework/types";

export type WebhookPayload = {
  data: {
    event_type: string;
    resource: {
      id: string;
      status: string;
      amount: {
        value: string;
        currency_code: string;
      };
      custom_id: string;
    };
  };
  rawData: any;
  headers: Record<string, any>;
} & ProviderWebhookPayload["payload"];

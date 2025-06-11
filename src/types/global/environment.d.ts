declare namespace NodeJS {
  export interface ProcessEnv {
    PAYPAL_CLIENT_ID: string;
    PAYPAL_CLIENT_SECRET: string;
    PAYPAL_WEBHOOK_ID: string;
    PAYPAL_SANDBOX: string;
  }
}

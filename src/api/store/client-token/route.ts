import { MedusaRequest, MedusaResponse } from "@medusajs/framework";

import { PostStorePaypalPaymentType } from "./validators";
import { PaypalService } from "../../../modules/paypal/paypal-core";

const base =
  process.env.PAYPAL_SANDBOX === "true"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";

export const POST = async (
  req: MedusaRequest<PostStorePaypalPaymentType>,
  res: MedusaResponse
) => {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const isSandbox = process.env.PAYPAL_SANDBOX === "true";

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing PayPal credentials. Please set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in your environment variables."
    );
  }

  const paypalService = new PaypalService({
    clientId,
    clientSecret,
    isSandbox,
  });

  const accessToken = await paypalService.getAccessToken();

  const response = await fetch(`${base}/v1/identity/generate-token`, {
    method: "post",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Accept-Language": "en_US",
      "Content-Type": "application/json",
    },
  });

  const data = await response.json();

  return res.status(201).json({ clientToken: data.client_token });
};

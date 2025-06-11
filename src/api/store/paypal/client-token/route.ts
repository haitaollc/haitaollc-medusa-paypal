import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { PostStorePaypalPaymentType } from "./validators";
//@ts-ignore
import { PaypalService } from "@alphabite/medusa-paypal/providers/paypal/paypal-core";

interface PaymentProvidersProps {
  resolve: string;
  id: string;
  options: Record<string, any>;
}

const base =
  process.env.PAYPAL_SANDBOX === "true"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";

export const POST = async (
  req: MedusaRequest<PostStorePaypalPaymentType>,
  res: MedusaResponse
) => {
  const paymentModule = req.scope.resolve("payment");

  //@ts-ignore
  const paymentProviders = paymentModule.moduleDeclaration
    .providers as PaymentProvidersProps[];

  const paypalProvider = paymentProviders.find(
    (provider) => provider.id === "paypal"
  );

  if (!paypalProvider) {
    return res.status(404).json({ error: "Paypal provider not found" });
  }

  const paypalService = new PaypalService({
    clientId: paypalProvider.options.clientId,
    clientSecret: paypalProvider.options.clientSecret,
    isSandbox: paypalProvider.options.isSandbox,
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

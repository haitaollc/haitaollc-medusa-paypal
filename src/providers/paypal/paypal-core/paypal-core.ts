import {
  CheckoutPaymentIntent,
  Client,
  Environment,
  LogLevel,
  OAuthAuthorizationController,
  Order,
  OrderAuthorizeResponse,
  OrdersController,
  PaymentsController,
  Refund,
  Item,
  ShippingDetails,
  OrderApplicationContextShippingPreference,
  OrderApplicationContextUserAction,
  FulfillmentType,
} from "@paypal/paypal-server-sdk";
import axios, { AxiosInstance } from "axios";
import { CartAddressDTO, CartLineItemDTO } from "@medusajs/framework/types";
import { parsePhoneNumberFromString } from "libphonenumber-js";

export interface PaypalCreateOrderInput {
  amount: number;
  currency: string;
  sessionId?: string;
  shipping_info?: CartAddressDTO;
  items?: CartLineItemDTO[];
  email?: string;
}

export class PaypalService {
  private client: Client;
  private ordersController: OrdersController;
  private paymentsController: PaymentsController;
  private authController: OAuthAuthorizationController;
  private axios: AxiosInstance;
  private clientIdEnv: string;
  private clientSecretEnv: string;
  private paypalWebhookIdEnv: string | undefined;
  private includeShippingData: boolean | undefined;
  private includeCustomerData: boolean | undefined;

  constructor({
    clientId,
    clientSecret,
    isSandbox,
    paypalWebhookId,
    includeCustomerData,
    includeShippingData,
  }: {
    clientId: string;
    clientSecret: string;
    isSandbox: boolean;
    paypalWebhookId?: string;
    includeShippingData?: boolean;
    includeCustomerData?: boolean;
  }) {
    const environment = isSandbox ? Environment.Sandbox : Environment.Production;

    this.client = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: clientId,
        oAuthClientSecret: clientSecret,
      },
      timeout: 0,
      environment,
      logging: {
        logLevel: LogLevel.Info,
        logRequest: {
          logBody: true,
        },
        logResponse: {
          logHeaders: true,
        },
      },
    });

    this.axios = axios.create({
      baseURL: isSandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com",
    });
    this.clientIdEnv = clientId;
    this.clientSecretEnv = clientSecret;
    this.paypalWebhookIdEnv = paypalWebhookId;

    this.ordersController = new OrdersController(this.client);
    this.paymentsController = new PaymentsController(this.client);
    this.authController = new OAuthAuthorizationController(this.client);

    this.includeCustomerData = includeCustomerData;
    this.includeShippingData = includeShippingData;
  }

  private extractCustomerData() {}

  private extractShippingData() {}

  async createOrder({
    amount,
    currency,
    sessionId,
    shipping_info,
    items,
    email,
  }: PaypalCreateOrderInput): Promise<Order> {
    const ordersController = new OrdersController(this.client);

    const paypalItems: Item[] = items
      ? items.map((item) => ({
          name: item.title,
          quantity: item.quantity.toString(),
          unitAmount: {
            currencyCode: currency,
            value: item.unit_price.toString(),
          },
        }))
      : [];
    const isItems = paypalItems.length > 0;

    const parsed_phone_number = shipping_info?.phone ? parsePhoneNumberFromString(shipping_info.phone) : null;

    const paypalShipping: ShippingDetails = shipping_info
      ? {
          ...(this.includeCustomerData && {
            name: {
              fullName: `${shipping_info.first_name} ${shipping_info.last_name}`,
            },
            emailAddress: email,
            ...(parsed_phone_number && {
              phoneNumber: {
                countryCode: parsed_phone_number.countryCallingCode,
                nationalNumber: parsed_phone_number.nationalNumber,
              },
            }),
          }),
          ...(this.includeShippingData && {
            address: {
              countryCode: shipping_info?.country_code!,
              postalCode: shipping_info?.postal_code,
              adminArea1: shipping_info?.province,
              adminArea2: shipping_info?.city,
              addressLine1: shipping_info?.address_1,
            },
          }),
          type: FulfillmentType.Shipping,
        }
      : {};

    const isShippingData = Object.keys(paypalShipping).length > 0;

    const createdOrder = await ordersController.createOrder({
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            amount: {
              currencyCode: currency,
              value: amount.toString(),
              ...(isItems && {
                breakdown: {
                  itemTotal: {
                    currencyCode: currency,
                    value: amount.toString(),
                  },
                },
              }),
            },
            customId: sessionId,
            ...(isItems && { items: paypalItems }),
            ...(isShippingData && { shipping: paypalShipping }),
          },
        ],
        applicationContext: {
          ...(this.includeShippingData &&
            isShippingData && {
              shippingPreference: OrderApplicationContextShippingPreference.SetProvidedAddress,
            }),
          userAction: OrderApplicationContextUserAction.PayNow,
        },
      },
    });

    if (!createdOrder?.result?.id) throw new Error("Failed to create order");

    return createdOrder.result;
  }

  async getAccessToken(): Promise<string> {
    try {
      const authorization = Buffer.from(`${this.clientIdEnv}:${this.clientSecretEnv}`).toString("base64");

      const authRes = await this.authController.requestToken({
        authorization: `Basic ${authorization}`,
      });

      const accessToken = authRes.result.accessToken;

      if (!accessToken) throw new Error("Failed to get access token");

      return accessToken;
    } catch (error) {
      throw new Error("Failed to get access token: " + error.message);
    }
  }

  async authorizeOrder(id: string): Promise<OrderAuthorizeResponse> {
    const authorizedOrder = await this.ordersController.authorizeOrder({
      id,
    });

    return authorizedOrder.result;
  }

  async captureOrder(id: string): Promise<Order> {
    const capturedOrder = await this.ordersController.captureOrder({
      id,
    });

    return capturedOrder.result;
  }

  async refundPayment(captureIds: string[]): Promise<Refund[]> {
    const refunds: Refund[] = [];

    for (const captureId of captureIds) {
      const refund = await this.paymentsController.refundCapturedPayment({
        captureId,
      });

      refunds.push(refund.result);
    }

    return refunds;
  }

  async getOrderDetails(id: string): Promise<Order> {
    const orderDetails = await this.ordersController.getOrder({
      id,
    });

    return orderDetails.result;
  }

  public verifyWebhook = async ({
    headers,
    body,
  }: {
    headers: Record<string, string>;
    body: object;
  }): Promise<{ body: object; status: "SUCCESS" | "FAILURE" }> => {
    const accessToken = await this.getAccessToken();

    const verifyWebhookRes = await this.axios.post(
      "/v1/notifications/verify-webhook-signature",
      {
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: this.paypalWebhookIdEnv || "",
        webhook_event: body,
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (verifyWebhookRes.data.verification_status !== "SUCCESS") {
      throw new Error("Failed to verify webhook signature");
    }

    return { status: verifyWebhookRes.data.verification_status, body };
  };
}

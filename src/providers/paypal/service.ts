import {
  AbstractPaymentProvider,
  MedusaError,
  PaymentSessionStatus,
} from "@medusajs/framework/utils";
import {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  RefundPaymentInput,
  RefundPaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types";
import { CaptureStatus, Order } from "@paypal/paypal-server-sdk";

import { PaypalService } from "./paypal-core";
import { WebhookPayload } from "./types";

export interface PaypalPaymentError {
  code: string;
  message: string;
  retryable: boolean;
  avsCode?: string;
  cvvCode?: string;
}

type Options = {
  clientId: string;
  clientSecret: string;
  webhookId?: string;
  isSandbox: boolean;
};

type InjectedDependencies = {
  logger: Logger;
  paymentModuleService: any;
};

export default class PaypalModuleService extends AbstractPaymentProvider<Options> {
  static identifier = "paypal";

  protected logger_: Logger;
  public options_: Options;
  public client: PaypalService;
  protected baseUrl: string;
  protected paymentModuleService_: any;

  static validateOptions(options: Record<string, any>): void {
    if (!options.clientId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "PayPal client ID is required in the provider's options."
      );
    }

    if (!options.clientSecret) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "PayPal client secret is required in the provider's options."
      );
    }
  }

  constructor(container: InjectedDependencies, options: Options) {
    super(container, options);

    this.logger_ = container.logger;
    this.options_ = options;
    this.baseUrl = this.options_.isSandbox
      ? "https://api-m.sandbox.paypal.com"
      : "https://api-m.paypal.com";
    this.paymentModuleService_ = container.paymentModuleService;
    this.client = new PaypalService({
      clientId: this.options_.clientId,
      clientSecret: this.options_.clientSecret,
      isSandbox: this.options_.isSandbox,
      paypalWebhookId: this.options_.webhookId,
    });
  }

  async capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    // console.log(">>>>> STEP 7 - CAPTURING PAYMENT INIT");

    try {
      if (!input.data) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Payment data is required"
        );
      }

      if (!input.data.id) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "PayPal order ID is required to capture payment"
        );
      }

      if (
        input.data.status === PaymentSessionStatus.CAPTURED ||
        input.data.status === "COMPLETED"
      ) {
        return {
          data: {
            ...input.data,
            status: PaymentSessionStatus.CAPTURED,
            captured_at: new Date().toISOString(),
          },
        };
      }

      // console.log(
      //   ">>>>>> STEP 8 - CAPTURE ORDER, IS AUTHORIZED, ATTEMPTING TO CAPTURE"
      // );

      const id = input.data.id as string;

      await this.client.captureOrder(id);

      return {
        data: {
          ...input.data,
          status: PaymentSessionStatus.CAPTURED,
          captured_at: new Date().toISOString(),
        },
      };
    } catch (error) {
      this.logger_.error("PayPal capture payment error:", error);
      throw error;
    }
  }

  async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    console.log(">>>>>>>Authorize payment<<<<<");

    if (!input.data) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Payment data is required"
      );
    }

    let paypalData = input.data as Order | undefined;

    const amount = input.data.amount as number;
    const currencyCode = input.data.currency_code as string;
    const orderId = paypalData?.id as string;

    if (!orderId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "PayPal order ID is required to capture payment"
      );
    }

    // console.log(">>>>> STEP 2 - CHECK IF ALREADY AUTHORIZED");
    // console.log(">>>>>> STEP 2.1 INPUT DATA", {
    //   amount,
    //   currencyCode,
    //   orderId,
    // });
    const alreadyAuthorized =
      paypalData?.purchaseUnits?.[0].payments?.captures?.[0]?.status ===
      CaptureStatus.Completed;

    if (!alreadyAuthorized) {
      // console.log(
      //   ">>>>> STEP 3 - CAPTURE ORDER, IS AUTHORIZED, ATTEMPTING TO CAPTURE ",
      //   alreadyAuthorized
      // );

      let captureResponse;

      try {
        captureResponse = await this.client.captureOrder(orderId);
      } catch (err) {
        // console.log(
        //   ">>>>>> STEP 3.1 - CAPTURE ORDER FAILED",
        //   JSON.stringify(err, null, 2)
        // );
        const body = JSON.parse(err?.body || "{}");

        // console.log(
        //   ">>>>>> STEP 3.2 - CAPTURE ORDER FAILED BODY",
        //   JSON.stringify(err?.body || {}, null, 2)
        // );

        const captureData = body?.purchase_units?.[0]?.payments?.captures?.[0];

        const newOrder = await this.client.createOrder({
          amount: Number(amount),
          currency: currencyCode,
          sessionId: input.context?.idempotency_key,
        });

        if (!captureData) {
          const error: PaypalPaymentError = {
            code: "404",
            message:
              "Payment declined. Please try again or use a different card.",
            retryable: true,
          };

          return {
            status: PaymentSessionStatus.PENDING,
            data: {
              ...input.data,
              ...newOrder,
              error,
            },
          };
        }

        const paymentStatus = captureData?.status || CaptureStatus.Declined;
        const processorResponse = captureData?.processorResponse;

        const { status, error = undefined } = this.checkPaymentStatus(
          paymentStatus,
          processorResponse
        );

        return {
          status: PaymentSessionStatus.PENDING,
          data: {
            ...input.data,
            ...newOrder,
            error,
          },
        };
      }

      paypalData = captureResponse;

      const captureData =
        captureResponse.purchaseUnits?.[0].payments?.captures?.[0];

      const paymentStatus = captureData?.status || CaptureStatus.Declined;
      const processorResponse = captureData?.processorResponse;

      const { status, error = undefined } = this.checkPaymentStatus(
        paymentStatus,
        processorResponse
      );

      // console.log(">>>>> STEP 4 - CHECK PAYMENT STATUS", status, error);

      if (status === CaptureStatus.Declined) {
        // console.log(">>>>> STEP 4.1 - PAYMENT DECLINED");
        const newOrder = await this.client.createOrder({
          amount: Number(captureData?.amount?.value),
          currency: captureData?.amount?.currencyCode!,
          sessionId: input.context?.idempotency_key,
        });

        // console.log(">>>>> STEP 4.2 - NEW ORDER CREATED", newOrder);

        console.log(
          ">>>>> STEP 4.3 - RETURNING DECLINED PAYMENT DATA",
          JSON.stringify(
            {
              status: PaymentSessionStatus.PENDING,
              data: {
                ...input.data,
                ...newOrder,
                error,
              },
            },
            null,
            2
          )
        );

        return {
          status: PaymentSessionStatus.PENDING,
          data: {
            ...input.data,
            ...newOrder,
            error,
          },
        };
      }
    }

    // console.log(">>>>> STEP 5 - RETURN AUTHORIZED PAYMENT DATA");

    return {
      data: {
        ...paypalData,
      },
      status: PaymentSessionStatus.AUTHORIZED,
    };
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    console.log("??????????>>>>>Cancel payment<<<<<", input);
    try {
      if (!input.data) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Payment data is required"
        );
      }

      const orderId = input.data["id"] as string;

      if (!orderId) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Cancel payment failed! PayPal order ID and capture ID is required to cancel payment"
        );
      }

      return {
        data: {
          order_id: orderId,
          status: PaymentSessionStatus.CANCELED,
          cancelled_at: new Date().toISOString(),
        },
      };
    } catch (error) {
      this.logger_.error("PayPal cancel payment error:", error);
      throw error;
    }
  }

  async initiatePayment(
    input: InitiatePaymentInput
  ): Promise<InitiatePaymentOutput> {
    // console.log(">>>>>>>Initiate payment<<<<<");

    try {
      const { amount, currency_code, context, data } = input;

      const order = await this.client.createOrder({
        amount: Number(amount),
        currency: currency_code,
        sessionId: context?.idempotency_key,
      });

      return {
        data: { ...data, ...order, amount, currency_code },
        id: order.id!,
      };
    } catch (error) {
      this.logger_.error("PayPal initiate payment error:", error);
      throw error;
    }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    // console.log(">>>>>>>Refund payment<<<<<");

    try {
      if (!input.data) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Payment data is required"
        );
      }

      const orderId = input.data["id"] as string;

      //@ts-ignore
      const captureIds = input.data.purchaseUnits.flatMap((item) =>
        item.payments.captures.map((capture) => capture.id)
      );

      if (!orderId || !captureIds) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Refund payment failed! PayPal order ID and capture ID is required to cancel payment"
        );
      }

      await this.client.cancelPayment(captureIds);

      return {
        data: {
          order_id: orderId,
          status: PaymentSessionStatus.CANCELED,
          cancelled_at: new Date().toISOString(),
        },
      };
    } catch (error) {
      this.logger_.error("PayPal cancel payment error:", error);
      throw error;
    }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    // console.log(">>>>>>>Delete payment<<<<<");
    // console.log("Delete payment input", input);

    try {
      if (!input.data) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Payment data is required"
        );
      }

      const orderId = input.data["id"] as string;

      // //@ts-ignore
      // const captureIds = input.data.captureData.purchaseUnits.flatMap((item) =>
      //   item.payments.captures.map((capture) => capture.id)
      // );

      // if (!orderId || !captureIds)
      if (!orderId) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Delete payment failed! PayPal order ID and capture ID is required to cancel payment"
        );
      }

      // await this.client.cancelPayment(captureIds);

      return {
        data: {
          order_id: orderId,
          status: PaymentSessionStatus.CANCELED,
          cancelled_at: new Date().toISOString(),
        },
      };
    } catch (error) {
      this.logger_.error("PayPal cancel payment error:", error);
      throw error;
    }
  }

  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    // console.log(">>>>>>>Get payment status<<<<<");
    try {
      if (!input.data) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Payment data is required"
        );
      }

      const order_id = input.data["id"] as string;

      if (!order_id) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "PayPal order ID is required to cancel payment"
        );
      }

      const order = await this.client.getOrderDetails(order_id);

      if (!order || !order.status) {
        throw new MedusaError(
          MedusaError.Types.NOT_FOUND,
          `PayPal order with ID ${order_id} not found`
        );
      }

      return {
        status:
          order.status === "COMPLETED"
            ? PaymentSessionStatus.CAPTURED
            : PaymentSessionStatus.AUTHORIZED,
      };
    } catch (error) {
      this.logger_.error("PayPal get payment status error:", error);
      throw error;
    }
  }

  async retrievePayment(input: Record<string, unknown>) {
    // console.log(">>>>>>>Retrieve payment <<<<<");

    try {
      const id = input["id"] as string;

      const res = await this.client.getOrderDetails(id);
      return {
        data: { response: res },
      };
    } catch (error) {
      this.logger_.error("PayPal retrieve payment error:", error);
      throw error;
    }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    // console.log(">>>>>>>Update payment<<<<<");

    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Not implemented");
    // try {
    //   if (!input.data) {
    //     throw new MedusaError(
    //       MedusaError.Types.INVALID_DATA,
    //       "Payment data is required"
    //     );
    //   }

    //   const order_id = input.data["order_id"] as string;

    //   if (!order_id) {
    //     throw new MedusaError(
    //       MedusaError.Types.INVALID_DATA,
    //       "PayPal order ID is required to cancel payment"
    //     );
    //   }

    //   const accessToken = await this.getAccessToken();

    //   const response = await fetch(``, {
    //     method: "PATCH",
    //     headers: {
    //       "Content-Type": "application/json",
    //       Authorization: `Bearer ${accessToken}`,
    //     },
    //     body: JSON.stringify([
    //       {
    //         op: "replace",
    //         value: {
    //           address_line_1: "2211 N First Street",
    //           address_line_2: "Building 17",
    //           admin_area_2: "San Jose",
    //           admin_area_1: "CA",
    //           postal_code: "95131",
    //           country_code: "US",
    //         },
    //       },
    //     ]),
    //   });

    //   if (!response.ok) {
    //     const errorData = await response.json();
    //     throw new MedusaError(
    //       MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR,
    //       `PayPal update failed: ${errorData.message}`
    //     );
    //   }

    //   const data = await response.json();

    //   return {
    //     data: { success: true, message: "payment updated", ...data },
    //   };
    // } catch (error) {
    //   this.logger_.error("PayPal update payment error:", error);
    //   throw error;
    // }
  }

  async getWebhookActionAndData(
    payload: WebhookPayload
  ): Promise<WebhookActionResult> {
    try {
      const { data, headers } = payload;

      await this.client.verifyWebhook({ headers, body: data });

      switch (data.event_type) {
        case "PAYMENT.CAPTURE.COMPLETED":
          // console.log(">>>>> STEP 6 PAYMENT.CAPTURE.COMPLETED<<<<<");
          return {
            action: "captured",
            data: {
              session_id: data.resource.custom_id,
              amount: Number(data.resource.amount.value),
            },
          };
        default:
          return {
            action: "not_supported",
          };
      }
    } catch (e) {
      return {
        action: "failed",
        data: {
          session_id: payload.data.resource.custom_id,
          amount: Number(payload.data.resource.amount.value),
        },
      };
    }
  }

  private checkPaymentStatus(
    status: CaptureStatus,
    processorResponse?: {
      avsCode?: string;
      cvvCode?: string;
      responseCode?: string;
    }
  ): { status: CaptureStatus; error?: PaypalPaymentError } {
    const processorResponseMap: Record<string, PaypalPaymentError> = {
      "0500": {
        code: "0500 - DO_NOT_HONOR",
        message:
          "Card refused by issuer. Please try again or use a different card.",
        retryable: false,
      },
      "9500": {
        code: "9500 - SUSPECTED_FRAUD",
        message:
          "Suspected fraudulent card. Please try again and use a different card.",
        retryable: false,
      },
      "5400": {
        code: "5400 - EXPIRED_CARD",
        message: "Card has expired. Please try again and use a different card.",
        retryable: false,
      },
      "5120": {
        code: "5120 - INSUFFICIENT_FUNDS",
        message:
          "Insufficient funds. Please try again or use a different card.",
        retryable: true,
      },
      "00N7": {
        code: "00N7 - CVV_FAILURE",
        message:
          "Incorrect security code. Please try again or use a different card.",
        retryable: true,
      },
      "1330": {
        code: "1330 - INVALID_ACCOUNT",
        message: "Card not valid. Please try again or use a different card.",
        retryable: true,
      },
      "5100": {
        code: "5100 - GENERIC_DECLINE",
        message: "Card is declined. Please try again or use a different card.",
        retryable: true,
      },
    };

    // Check the payment status first
    switch (status) {
      case "COMPLETED":
        return { status };

      case "DECLINED":
        // If we have processor response details, use them
        console.log("Processor response details:", processorResponse);

        if (processorResponse?.responseCode) {
          const errorDetails = processorResponseMap[
            processorResponse.responseCode
          ] || {
            code: processorResponse.responseCode,
            message:
              "Payment declined. Please try again or use a different card.",
            retryable: false,
          };

          return {
            status,
            error: {
              ...errorDetails,
              avsCode: processorResponse.avsCode,
              cvvCode: processorResponse.cvvCode,
            },
          };
        }
        // Generic decline if no processor response
        return {
          status,
          error: {
            code: "DECLINED",
            message:
              "Payment declined. Please try again or use a different card.",
            retryable: false,
          },
        };

      default:
        return {
          status,
          error: {
            code: "UNKNOWN_STATUS",
            message: `Unknown payment status: ${status}. Please try again or use a different card.`,
            retryable: false,
          },
        };
    }
  }
}

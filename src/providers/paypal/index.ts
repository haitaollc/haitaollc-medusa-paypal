import { Modules, ModuleProvider } from "@medusajs/framework/utils";
import PaypalModuleService from "./service";

export const PAYPAL_MODULE = "paypal";

export default ModuleProvider(Modules.PAYMENT, {
  services: [PaypalModuleService],
});

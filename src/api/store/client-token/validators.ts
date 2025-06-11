import { z } from 'zod'

export type PostStorePaypalPaymentType = z.infer<typeof PostStorePaypalPayment>
export const PostStorePaypalPayment = z.object({
    session_id: z.string()
})
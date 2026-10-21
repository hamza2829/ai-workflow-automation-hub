import { z } from 'zod';
export const orderSchema = z.object({customerId:z.string().uuid(),description:z.string().min(3).max(2000),amount:z.number().positive().max(1000000),currency:z.enum(['EUR','USD'])}).strict();
export const classificationSchema = z.object({category:z.enum(['engineering','sales','finance']),summary:z.string().min(1).max(1000),confidence:z.number().min(0).max(1)}).strict();
export const decisionSchema = z.object({decision:z.enum(['approved','rejected'])}).strict();
export const keySchema = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/);

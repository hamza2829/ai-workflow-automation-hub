import {describe,it,expect} from 'vitest';
import {orderSchema,classificationSchema,decisionSchema,keySchema} from './schema.js';
const order={customerId:'11111111-1111-4111-8111-111111111111',description:'New license seats',amount:120,currency:'EUR'};
describe('webhook payload contract',()=>{
 it('accepts a synthetic order',()=>expect(orderSchema.parse(order)).toEqual(order));
 it.each([{amount:0},{amount:-1},{amount:1000001},{currency:'GBP'},{customerId:'unknown'},{description:''},{unexpected:true}])('rejects invalid order %j',change=>expect(orderSchema.safeParse({...order,...change}).success).toBe(false));
});
describe('trust boundaries',()=>{
 it('accepts classification',()=>expect(classificationSchema.safeParse({category:'sales',summary:'Order',confidence:.9}).success).toBe(true));
 it.each([-1,1.1])('rejects confidence %s',confidence=>expect(classificationSchema.safeParse({category:'sales',summary:'Order',confidence}).success).toBe(false));
 it('rejects unknown category',()=>expect(classificationSchema.safeParse({category:'admin',summary:'Order',confidence:1}).success).toBe(false));
 it('rejects empty summary',()=>expect(classificationSchema.safeParse({category:'sales',summary:'',confidence:1}).success).toBe(false));
 it.each(['approved','rejected'])('accepts %s',decision=>expect(decisionSchema.parse({decision}).decision).toBe(decision));
 it('rejects arbitrary decision',()=>expect(decisionSchema.safeParse({decision:'skip'}).success).toBe(false));
 it.each(['','short','invalid key'])('rejects invalid idempotency key %s',key=>expect(keySchema.safeParse(key).success).toBe(false));
 it('accepts valid key',()=>expect(keySchema.parse('order-test-123')).toBe('order-test-123'));
});

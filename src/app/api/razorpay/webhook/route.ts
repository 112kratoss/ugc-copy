import crypto from 'crypto';
import { createServiceClient } from '@/lib/server-helpers';

export async function POST(req: Request) {
    try {
        const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (!WEBHOOK_SECRET) {
            console.error('RAZORPAY_WEBHOOK_SECRET not configured');
            return new Response('Webhook secret not configured', { status: 500 });
        }

        const body = await req.text();
        const signature = req.headers.get('x-razorpay-signature');

        if (!signature) {
            return new Response('Missing signature', { status: 400 });
        }

        // Verify webhook signature
        const expectedSignature = crypto
            .createHmac('sha256', WEBHOOK_SECRET)
            .update(body)
            .digest('hex');

        if (signature !== expectedSignature) {
            console.error('Invalid webhook signature');
            return new Response('Invalid signature', { status: 400 });
        }

        const event = JSON.parse(body);
        let supabaseAdmin: ReturnType<typeof createServiceClient> | null = null;

        function getSupabaseAdmin() {
            supabaseAdmin ??= createServiceClient();
            return supabaseAdmin;
        }

        async function handleCreditTransaction(orderId: string, paymentId: string) {
            const { data: txn, error: txnError } = await getSupabaseAdmin()
                .from('transactions')
                .select('id, user_id, credits, status')
                .eq('razorpay_order_id', orderId)
                .maybeSingle();

            if (txnError) {
                console.error('Webhook: Failed to load credit transaction for order', orderId, txnError);
                return { handled: false, shouldRetry: false };
            }

            if (!txn) {
                return { handled: false, shouldRetry: false };
            }

            if (txn.status === 'success') {
                console.log('Webhook: Credit transaction already processed', orderId);
                return { handled: true, shouldRetry: false };
            }

            const { error: rpcError } = await getSupabaseAdmin().rpc('add_credits', {
                p_user_id: txn.user_id,
                p_credits: txn.credits,
                p_transaction_id: txn.id,
                p_payment_id: paymentId,
            });

            if (rpcError) {
                console.error('Webhook: add_credits RPC failed', rpcError);
                return { handled: true, shouldRetry: true };
            }

            console.log(
                `Webhook: Credits assigned — user=${txn.user_id}, credits=${txn.credits}, order=${orderId}`
            );
            return { handled: true, shouldRetry: false };
        }

        async function handleMarketplaceOrder(orderId: string, paymentId: string) {
            const { data: marketplaceOrder, error: marketplaceOrderError } = await getSupabaseAdmin()
                .from('marketplace_orders')
                .select('id, status, buyer_user_id')
                .eq('razorpay_order_id', orderId)
                .maybeSingle();

            if (marketplaceOrderError) {
                console.error('Webhook: Failed to load marketplace order for order', orderId, marketplaceOrderError);
                return { handled: false, shouldRetry: false };
            }

            if (!marketplaceOrder) {
                return { handled: false, shouldRetry: false };
            }

            if (marketplaceOrder.status === 'paid') {
                console.log('Webhook: Marketplace order already processed', orderId);
                return { handled: true, shouldRetry: false };
            }

            const { error: rpcError } = await getSupabaseAdmin().rpc('complete_marketplace_purchase', {
                p_razorpay_order_id: orderId,
                p_razorpay_payment_id: paymentId,
            });

            if (rpcError) {
                console.error('Webhook: complete_marketplace_purchase RPC failed', rpcError);
                return { handled: true, shouldRetry: true };
            }

            console.log(`Webhook: Marketplace purchase completed — buyer=${marketplaceOrder.buyer_user_id}, order=${orderId}`);
            return { handled: true, shouldRetry: false };
        }

        async function handlePostResourceBundleOrder(orderId: string, paymentId: string) {
            const { data: bundleOrder, error: bundleOrderError } = await getSupabaseAdmin()
                .from('post_resource_bundle_orders')
                .select('id, status, buyer_user_id')
                .eq('razorpay_order_id', orderId)
                .maybeSingle();

            if (bundleOrderError) {
                console.error('Webhook: Failed to load post resource bundle order for order', orderId, bundleOrderError);
                return { handled: true, shouldRetry: true };
            }

            if (!bundleOrder) {
                return { handled: false, shouldRetry: false };
            }

            if (bundleOrder.status === 'paid') {
                console.log('Webhook: Post resource bundle order already processed', orderId);
                return { handled: true, shouldRetry: false };
            }

            const { data: completionResult, error: rpcError } = await getSupabaseAdmin().rpc('complete_post_resource_bundle_purchase', {
                p_razorpay_order_id: orderId,
                p_razorpay_payment_id: paymentId,
            });

            if (rpcError) {
                console.error('Webhook: complete_post_resource_bundle_purchase RPC failed', rpcError);
                return { handled: true, shouldRetry: true };
            }

            if (!completionResult) {
                const { data: refreshedOrder, error: refreshedOrderError } = await getSupabaseAdmin()
                    .from('post_resource_bundle_orders')
                    .select('status')
                    .eq('razorpay_order_id', orderId)
                    .maybeSingle();

                if (refreshedOrderError) {
                    console.error('Webhook: Failed to reload post resource bundle order after completion attempt', orderId, refreshedOrderError);
                    return { handled: true, shouldRetry: true };
                }

                if (refreshedOrder?.status === 'paid') {
                    console.log('Webhook: Post resource bundle order completed during concurrent verification', orderId);
                    return { handled: true, shouldRetry: false };
                }

                console.error('Webhook: Post resource bundle order remained unresolved after completion attempt', orderId);
                return { handled: true, shouldRetry: true };
            }

            console.log(`Webhook: Post resource bundle purchase completed — buyer=${bundleOrder.buyer_user_id}, order=${orderId}`);
            return { handled: true, shouldRetry: false };
        }

        // Handle payment.captured event
        if (event.event === 'payment.captured') {
            const payment = event.payload?.payment?.entity;

            if (!payment) {
                console.error('Webhook: Missing payment entity');
                return new Response('OK', { status: 200 }); // Acknowledge but skip
            }

            const orderId = payment.order_id;
            const paymentId = payment.id;

            if (!orderId) {
                console.error('Webhook: Missing order_id in payment');
                return new Response('OK', { status: 200 });
            }

            const creditResult = await handleCreditTransaction(orderId, paymentId);
            if (creditResult.shouldRetry) {
                return new Response('Failed to assign credits', { status: 500 });
            }
            if (creditResult.handled) {
                return new Response('OK', { status: 200 });
            }

            const marketplaceResult = await handleMarketplaceOrder(orderId, paymentId);
            if (marketplaceResult.shouldRetry) {
                return new Response('Failed to finalize marketplace purchase', { status: 500 });
            }
            if (marketplaceResult.handled) {
                return new Response('OK', { status: 200 });
            }

            const bundleOrderResult = await handlePostResourceBundleOrder(orderId, paymentId);
            if (bundleOrderResult.shouldRetry) {
                return new Response('Failed to finalize post resource bundle purchase', { status: 500 });
            }
            if (bundleOrderResult.handled) {
                return new Response('OK', { status: 200 });
            }

            console.log('Webhook: No matching transaction, marketplace order, or post resource bundle order for order', orderId);
        }

        // Always return 200 for events we don't handle (to prevent Razorpay retries)
        return new Response('OK', { status: 200 });
    } catch (error) {
        console.error('Webhook processing error:', error);
        return new Response('Internal error', { status: 500 });
    }
}

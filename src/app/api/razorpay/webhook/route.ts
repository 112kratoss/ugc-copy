import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

export async function POST(req: Request) {
    try {
        const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (!WEBHOOK_SECRET) {
            console.error('RAZORPAY_WEBHOOK_SECRET not configured');
            return new Response('Webhook secret not configured', { status: 500 });
        }

        const body = await req.text();
        const signature = req.headers.get('x-razorpay-signature');

        // Create admin client inside handler to avoid build-time crashes
        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );

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

            // Look up the transaction by Razorpay order ID
            const { data: txn, error: txnError } = await supabaseAdmin
                .from('transactions')
                .select('id, user_id, credits, status')
                .eq('razorpay_order_id', orderId)
                .single();

            if (txnError || !txn) {
                console.error('Webhook: Transaction not found for order', orderId, txnError);
                return new Response('OK', { status: 200 }); // Acknowledge — don't retry
            }

            if (txn.status === 'success') {
                // Already processed (idempotent) — the existing add_credits RPC also checks this
                console.log('Webhook: Transaction already processed', orderId);
                return new Response('OK', { status: 200 });
            }

            // Call the existing add_credits RPC to atomically credit the user
            const { data: rpcSuccess, error: rpcError } = await supabaseAdmin.rpc('add_credits', {
                p_user_id: txn.user_id,
                p_credits: txn.credits,
                p_transaction_id: txn.id,
                p_payment_id: paymentId,
            });

            if (rpcError) {
                console.error('Webhook: add_credits RPC failed', rpcError);
                // Return 500 so Razorpay retries
                return new Response('Failed to assign credits', { status: 500 });
            }

            console.log(
                `Webhook: Credits assigned — user=${txn.user_id}, credits=${txn.credits}, order=${orderId}, rpcResult=${rpcSuccess}`
            );
        }

        // Always return 200 for events we don't handle (to prevent Razorpay retries)
        return new Response('OK', { status: 200 });
    } catch (error) {
        console.error('Webhook processing error:', error);
        return new Response('Internal error', { status: 500 });
    }
}

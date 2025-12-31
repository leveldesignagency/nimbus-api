// Vercel serverless function to process refunds
// Allows users to request refunds within 7 days of purchase

export default async function handler(req, res) {
  // Set CORS headers to allow Chrome extension requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { subscriptionId, email } = req.body;

    if (!subscriptionId && !email) {
      return res.status(400).json({ error: 'Subscription ID or email required' });
    }

    // Check for test keys first (if TEST_STRIPE_SECRET_KEY is set, use test mode)
    const useTestMode = !!process.env.TEST_STRIPE_SECRET_KEY;
    const stripeSecretKey = useTestMode 
      ? process.env.TEST_STRIPE_SECRET_KEY 
      : process.env.STRIPE_SECRET_KEY;
    
    if (!stripeSecretKey) {
      console.error(useTestMode ? 'TEST_STRIPE_SECRET_KEY' : 'STRIPE_SECRET_KEY', 'environment variable not set');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const stripe = (await import('stripe')).default(stripeSecretKey);

    // Find the subscription
    let subscription;
    if (subscriptionId) {
      try {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
      } catch (e) {
        return res.status(404).json({ error: 'Subscription not found' });
      }
    } else {
      // Find by email
      const customers = await stripe.customers.list({
        email: email,
        limit: 1,
      });

      if (customers.data.length === 0) {
        return res.status(404).json({ error: 'Customer not found' });
      }

      const subscriptions = await stripe.subscriptions.list({
        customer: customers.data[0].id,
        limit: 1,
      });

      if (subscriptions.data.length === 0) {
        return res.status(404).json({ error: 'No subscription found for this customer' });
      }

      subscription = subscriptions.data[0];
    }

    // Check if subscription is within 7-day refund window
    const subscriptionStartDate = new Date(subscription.created * 1000);
    const now = new Date();
    const daysSincePurchase = (now - subscriptionStartDate) / (1000 * 60 * 60 * 24);

    if (daysSincePurchase > 7) {
      return res.status(400).json({ 
        error: 'Refund window expired',
        details: `Refunds are only available within 7 days of purchase. Your subscription was created ${Math.floor(daysSincePurchase)} days ago.`
      });
    }

    // Get the latest invoice to find the payment intent
    const invoices = await stripe.invoices.list({
      subscription: subscription.id,
      limit: 1,
    });

    if (invoices.data.length === 0) {
      return res.status(404).json({ error: 'No payment found for this subscription' });
    }

    const invoice = invoices.data[0];
    
    // If subscription is in trial, cancel it instead of refunding
    if (subscription.status === 'trialing') {
      await stripe.subscriptions.cancel(subscription.id);
      return res.status(200).json({
        success: true,
        message: 'Trial subscription cancelled',
        subscriptionId: subscription.id,
        cancelled: true,
      });
    }

    // Find the charge to refund
    if (!invoice.charge) {
      return res.status(404).json({ error: 'No charge found to refund' });
    }

    // Process the refund
    const refund = await stripe.refunds.create({
      charge: invoice.charge,
      reason: 'requested_by_customer',
    });

    // Cancel the subscription
    await stripe.subscriptions.cancel(subscription.id);

    return res.status(200).json({
      success: true,
      message: 'Refund processed successfully',
      refundId: refund.id,
      subscriptionId: subscription.id,
      amount: refund.amount / 100, // Convert from pence to pounds
      currency: refund.currency.toUpperCase(),
    });

  } catch (error) {
    console.error('Error processing refund:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message
    });
  }
}


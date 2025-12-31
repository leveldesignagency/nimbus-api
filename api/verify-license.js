// Vercel serverless function to verify license keys
// This checks if a license key is valid and active

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { licenseKey } = req.body;

    if (!licenseKey || typeof licenseKey !== 'string') {
      return res.status(400).json({ error: 'License key required' });
    }

    // Get Stripe secret key from environment variable
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    
    if (!stripeSecretKey) {
      console.error('STRIPE_SECRET_KEY environment variable not set');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Import Stripe (dynamic import for serverless)
    const stripe = (await import('stripe')).default(stripeSecretKey);

    // The license key format will be the Stripe customer ID or subscription ID
    // We'll search for the subscription by customer email or use the license key as subscription ID
    try {
      // Try to retrieve the subscription directly if licenseKey is a subscription ID
      let subscription;
      
      // First, try to get subscription by ID
      try {
        subscription = await stripe.subscriptions.retrieve(licenseKey);
      } catch (e) {
        // If that fails, search by customer email (licenseKey might be email)
        const customers = await stripe.customers.list({
          email: licenseKey,
          limit: 1,
        });
        
        if (customers.data.length > 0) {
          const subscriptions = await stripe.subscriptions.list({
            customer: customers.data[0].id,
            status: 'active',
            limit: 1,
          });
          
          if (subscriptions.data.length > 0) {
            subscription = subscriptions.data[0];
          }
        }
      }

      if (!subscription) {
        return res.status(404).json({ 
          valid: false, 
          error: 'License key not found or subscription not active' 
        });
      }

      // Check if subscription is active
      if (subscription.status !== 'active' && subscription.status !== 'trialing') {
        return res.status(200).json({ 
          valid: false, 
          error: 'Subscription is not active',
          status: subscription.status
        });
      }

      // Calculate expiry date
      const expiryDate = new Date(subscription.current_period_end * 1000);
      const now = new Date();

      if (expiryDate < now) {
        return res.status(200).json({ 
          valid: false, 
          error: 'Subscription has expired',
          expiryDate: expiryDate.toISOString()
        });
      }

      // License is valid
      return res.status(200).json({
        valid: true,
        subscriptionId: subscription.id,
        customerId: subscription.customer,
        status: subscription.status,
        expiryDate: expiryDate.toISOString(),
        currentPeriodEnd: subscription.current_period_end
      });

    } catch (stripeError) {
      console.error('Stripe error:', stripeError);
      return res.status(500).json({ 
        valid: false, 
        error: 'Error verifying license key' 
      });
    }

  } catch (error) {
    console.error('Error verifying license:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}


const Razorpay = require('razorpay');
const crypto = require('crypto');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'placeholder',
});

const createOrder = async (amount) => {
  return await razorpay.orders.create({
    amount: amount * 100,
    currency: 'INR',
    receipt: `receipt_${Date.now()}`,
  });
};

const verifyPaymentSignature = (orderId, paymentId, signature) => {
  const body = orderId + '|' + paymentId;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'placeholder')
    .update(body)
    .digest('hex');
  return expected === signature;
};

const verifyWebhookSignature = (bodyString, signature) => {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'placeholder')
    .update(bodyString)
    .digest('hex');
  return expected === signature;
};

module.exports = { razorpay, createOrder, verifyPaymentSignature, verifyWebhookSignature };

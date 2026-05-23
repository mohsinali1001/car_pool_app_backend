const { db } = require('../config/firebase');
const { ensureWallet, getBalance, addBalance } = require('../utils/walletHelper');

const getWallet = async (req, res) => {
  try {
    const wallet = await ensureWallet(req.user.uid);
    return res.json({ success: true, wallet });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'GET_WALLET_ERROR' });
  }
};

const getTransactions = async (req, res) => {
  try {
    const snap = await db
      .collection('transactions')
      .where('walletId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    const transactions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ success: true, count: transactions.length, transactions });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'GET_TRANSACTIONS_ERROR' });
  }
};

const topUpWallet = async (req, res) => {
  const { amount, reference } = req.body;
  if (!amount || amount <= 0 || amount > 50000) {
    return res.status(400).json({ success: false, error: 'Invalid amount', code: 'INVALID_AMOUNT' });
  }
  try {
    const newBalance = await addBalance(req.user.uid, amount, {
      type: 'topup',
      description: 'Manual top-up',
      reference: reference || `manual_${Date.now()}`,
    });
    const wallet = await ensureWallet(req.user.uid);
    return res.status(201).json({
      success: true,
      message: 'Wallet topped up',
      wallet: { ...wallet, balance: newBalance },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'TOPUP_ERROR' });
  }
};

const getEarningsSummary = async (req, res) => {
  try {
    const snap = await db
      .collection('transactions')
      .where('walletId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    const transactions = snap.docs.map((d) => d.data());
    let totalCredit = 0;
    let totalDebit = 0;
    const weekBuckets = [0, 0, 0, 0, 0, 0, 0];
    const now = new Date();

    for (const tx of transactions) {
      const amt = tx.amount || 0;
      if (tx.type === 'commission_deduction') {
        totalDebit += amt;
      } else {
        totalCredit += amt;
      }
      const created = new Date(tx.createdAt);
      const diffDays = Math.floor((now - created) / (1000 * 60 * 60 * 24));
      if (diffDays >= 0 && diffDays < 7) {
        const idx = 6 - diffDays;
        weekBuckets[idx] += tx.type === 'commission_deduction' ? -amt : amt;
      }
    }

    const ridesSnap = await db
      .collection('rides')
      .where('captainId', '==', req.user.uid)
      .where('status', '==', 'completed')
      .get();

    return res.json({
      success: true,
      summary: {
        totalEarnings: totalCredit,
        totalCommission: totalDebit,
        netEarned: totalCredit - totalDebit,
        ridesCompleted: ridesSnap.size,
        weekData: weekBuckets.map((v) => Math.max(0, v)),
        balance: await getBalance(req.user.uid),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, code: 'EARNINGS_SUMMARY_ERROR' });
  }
};

module.exports = { getWallet, getTransactions, topUpWallet, getEarningsSummary };

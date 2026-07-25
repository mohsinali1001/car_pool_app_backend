const { db } = require('../config/firebase');

const MIN_CAPTAIN_BALANCE = 200;
const CAPTAIN_STARTER_BALANCE = 5000;

async function ensureWallet(uid) {
  const ref = db.collection('wallets').doc(uid);
  const doc = await ref.get();
  const now = new Date().toISOString();
  if (!doc.exists) {
    const wallet = {
      id: uid,
      userId: uid,
      balance: CAPTAIN_STARTER_BALANCE,
      starterBalanceApplied: true,
      starterBalanceAmount: CAPTAIN_STARTER_BALANCE,
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(wallet);
    return wallet;
  }

  const data = doc.data() || {};
  const currentBalance = Number(data.balance || 0);
  const starterMissing = data.starterBalanceApplied !== true;
  const legacyZeroWallet =
    currentBalance <= 0 && data.starterBalanceAmount !== CAPTAIN_STARTER_BALANCE;
  if (starterMissing || legacyZeroWallet) {
    const txSnap = await db
      .collection('transactions')
      .where('walletId', '==', uid)
      .limit(1)
      .get();
    if (!txSnap.empty && !starterMissing) return { id: uid, ...data };
    const updated = {
      ...data,
      balance: CAPTAIN_STARTER_BALANCE,
      starterBalanceApplied: true,
      starterBalanceAmount: CAPTAIN_STARTER_BALANCE,
      updatedAt: now,
    };
    await ref.set(updated, { merge: true });
    return { id: uid, ...updated };
  }

  return { id: uid, ...doc.data() };
}

async function getBalance(uid) {
  const wallet = await ensureWallet(uid);
  return wallet.balance || 0;
}

async function recordTransaction({ walletId, type, amount, description, dealId, reference, balanceAfter }) {
  await db.collection('transactions').add({
    walletId,
    type,
    amount: Math.abs(amount),
    description: description || type,
    dealId: dealId || null,
    reference: reference || null,
    balanceAfter: balanceAfter ?? null,
    createdAt: new Date().toISOString(),
  });
}

async function addBalance(uid, amount, meta = {}) {
  const ref = db.collection('wallets').doc(uid);
  await ensureWallet(uid);
  let newBalance = 0;
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    newBalance = (snap.data().balance || 0) + amount;
    t.update(ref, {
      balance: newBalance,
      updatedAt: new Date().toISOString(),
    });
  });
  await recordTransaction({
    walletId: uid,
    type: meta.type || 'topup',
    amount,
    description: meta.description || 'Wallet top-up',
    reference: meta.reference,
    balanceAfter: newBalance,
  });
  return newBalance;
}

async function deductBalance(uid, amount, meta = {}) {
  const ref = db.collection('wallets').doc(uid);
  await ensureWallet(uid);
  let newBalance = 0;
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const current = snap.data().balance || 0;
    if (current < amount) {
      throw new Error(`Insufficient wallet balance (Rs. ${current}). Need Rs. ${amount}.`);
    }
    newBalance = current - amount;
    t.update(ref, {
      balance: newBalance,
      updatedAt: new Date().toISOString(),
    });
  });
  await recordTransaction({
    walletId: uid,
    type: meta.type || 'commission_deduction',
    amount,
    description: meta.description || 'Wallet deduction',
    dealId: meta.dealId,
    balanceAfter: newBalance,
  });
  return newBalance;
}

module.exports = {
  MIN_CAPTAIN_BALANCE,
  CAPTAIN_STARTER_BALANCE,
  ensureWallet,
  getBalance,
  recordTransaction,
  addBalance,
  deductBalance,
};

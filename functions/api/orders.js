import { buildPaymentLink, jsonResponse, supabaseRequest } from "../_lib.js";

const encoder = new TextEncoder();

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validateTelegramUser(initData, botToken) {
  const params = new Map(new URLSearchParams(initData));
  const receivedHash = params.get("hash");
  params.delete("hash");
  if (!receivedHash) throw new Error("Invalid Telegram data");

  const entries = [...params.entries()].sort(([left], [right]) => left.localeCompare(right));
  const checkString = entries.map(([key, value]) => `${key}=${value}`).join("\n");
  const secretKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const secret = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(botToken));
  const signingKey = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expectedHash = toHex(await crypto.subtle.sign("HMAC", signingKey, encoder.encode(checkString)));
  let difference = expectedHash.length ^ receivedHash.length;
  for (let index = 0; index < Math.max(expectedHash.length, receivedHash.length); index++) {
    difference |= (expectedHash.charCodeAt(index) || 0) ^ (receivedHash.charCodeAt(index) || 0);
  }
  if (difference !== 0) throw new Error("Invalid Telegram data");

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > 3600 || authDate > Date.now() / 1000 + 30) {
    throw new Error("Expired Telegram data");
  }

  const user = JSON.parse(params.get("user") || "null");
  if (!user || !Number.isSafeInteger(user.id)) throw new Error("Telegram user is missing");
  return user;
}

async function cancelPendingOrder(env, orderId) {
  await supabaseRequest(env, `orders?id=eq.${encodeURIComponent(orderId)}&status=eq.pending_payment`, {
    method: "PATCH",
    body: JSON.stringify({ status: "cancelled" }),
  });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request" }, 400);
  }

  let telegramUser = null;
  if (body.init_data) {
    if (!env.TELEGRAM_BOT_TOKEN) return jsonResponse({ error: "Telegram is not configured" }, 500);
    try {
      telegramUser = await validateTelegramUser(body.init_data, env.TELEGRAM_BOT_TOKEN);
    } catch {
      return jsonResponse({ error: "Telegram authentication failed" }, 401);
    }
  }

  const studentName = String(body.student_name || "").trim().slice(0, 120);
  const rollNumber = String(body.roll_number || "").trim().slice(0, 80);
  if (!telegramUser && (!studentName || !rollNumber)) {
    return jsonResponse({ error: "Student name and roll number are required" }, 400);
  }
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 30) {
    return jsonResponse({ error: "Cart is empty or invalid" }, 400);
  }

  const quantities = new Map();
  for (const line of body.items) {
    const quantity = Number(line.quantity);
    if (typeof line.menu_item_id !== "string" || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      return jsonResponse({ error: "Invalid cart item" }, 400);
    }
    quantities.set(line.menu_item_id, (quantities.get(line.menu_item_id) || 0) + quantity);
  }

  try {
    if (!env.UPI_VPA || !env.UPI_PAYEE_NAME) throw new Error("UPI configuration is missing");
    const menuResponse = await supabaseRequest(
      env,
      "menu_items?select=id,name,price,category&is_available=eq.true&order=category,name"
    );
    if (!menuResponse.ok) return jsonResponse({ error: "Could not load current menu" }, 502);
    const menuItems = await menuResponse.json();
    const menuById = new Map(menuItems.map((item) => [item.id, item]));
    const orderItems = [];
    let totalCents = 0;

    for (const [menuItemId, quantity] of quantities) {
      const item = menuById.get(menuItemId);
      if (!item) return jsonResponse({ error: "An item is no longer available" }, 400);
      const unitPriceCents = Math.round(Number(item.price) * 100);
      totalCents += unitPriceCents * quantity;
      orderItems.push({
        menu_item_id: item.id,
        item_name: item.name,
        unit_price: (unitPriceCents / 100).toFixed(2),
        quantity,
      });
    }

    const pickupSlot = ["Right now", "10:30 AM (today)"].includes(body.pickup_slot)
      ? body.pickup_slot
      : "Right now";
    const transactionId = crypto.randomUUID();
    const note = `LineZero order ${transactionId.slice(0, 8)}`;
    const orderResponse = await supabaseRequest(env, "orders?select=id", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        telegram_user_id: telegramUser?.id || 0,
        telegram_username: telegramUser?.username || null,
        student_name: telegramUser
          ? [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(" ")
          : studentName,
        roll_number: telegramUser ? null : rollNumber,
        total_amount: (totalCents / 100).toFixed(2),
        merchant_transaction_id: transactionId,
        status: "pending_payment",
        notes: `Pickup: ${pickupSlot}`,
      }),
    });
    if (!orderResponse.ok) return jsonResponse({ error: "Could not create order" }, 502);
    const order = (await orderResponse.json())[0];

    const itemsResponse = await supabaseRequest(env, "order_items", {
      method: "POST",
      body: JSON.stringify(orderItems.map((item) => ({ ...item, order_id: order.id }))),
    });
    if (!itemsResponse.ok) {
      await cancelPendingOrder(env, order.id);
      return jsonResponse({ error: "Could not save order items" }, 502);
    }

    const paymentUrl = new URL(`/pay/${transactionId}`, request.url).toString();
    if (telegramUser) {
      const message = [
        "LineZero order created",
        ...orderItems.map((item) => `${item.quantity} x ${item.item_name} - Rs. ${(Number(item.unit_price) * item.quantity).toFixed(2)}`),
        `Total: Rs. ${(totalCents / 100).toFixed(2)}`,
        `Pickup: ${pickupSlot}`,
      ].join("\n");
      const telegramResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramUser.id,
          text: message,
          reply_markup: {
            inline_keyboard: [
              [{ text: "Pay with UPI", url: paymentUrl }],
              [
                { text: "I've Paid", callback_data: `paid:${order.id}` },
                { text: "Cancel", callback_data: `cancel:${order.id}` },
              ],
            ],
          },
        }),
      });
      if (!telegramResponse.ok) return jsonResponse({ error: "Could not send order to Telegram" }, 502);
      return jsonResponse({ order_id: order.id, total: totalCents / 100 });
    }

    return jsonResponse({ order_id: order.id, total: totalCents / 100, payment_url: paymentUrl });
  } catch {
    return jsonResponse({ error: "Could not place order" }, 500);
  }
}
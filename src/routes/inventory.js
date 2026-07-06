import { Router } from "express";
import { db } from "@workspace/db";
import { inventoryProductsTable, stockMovementsTable, purchaseOrdersTable, vendorsTable, } from "@workspace/db";
import { eq, sql, desc, and, like, or } from "drizzle-orm";
import { requireRole } from "../middlewares/auth";
const router = Router();
const storeRoles = ["admin", "store_manager"];
const readStoreRoles = ["admin", "store_manager", "accountant"];
// ─── PRODUCTS ──────────────────────────────────────────────────────────────
router.get("/inventory/categories", requireRole(...readStoreRoles), async (req, res) => {
    try {
        const categoriesResult = await db.selectDistinct({ category: inventoryProductsTable.category }).from(inventoryProductsTable);
        const categories = categoriesResult.map((c) => c.category);
        return res.json(categories);
    } catch (err) {
        req.log.error({ err }, "List categories error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/inventory/products", requireRole(...readStoreRoles), async (req, res) => {
    try {
        const { search, category, page, limit } = req.query;
        let query = db.select().from(inventoryProductsTable);
        const conditions = [];
        if (category && category !== "all") {
            if (category === "low") {
                conditions.push(sql`${inventoryProductsTable.currentStock} <= ${inventoryProductsTable.reorderThreshold}`);
            } else {
                conditions.push(eq(inventoryProductsTable.category, String(category)));
            }
        }
        if (search) {
            const pattern = `%${String(search).toLowerCase()}%`;
            conditions.push(
                or(
                    like(sql`lower(${inventoryProductsTable.name})`, pattern),
                    like(sql`lower(${inventoryProductsTable.description})`, pattern)
                )
            );
        }
        let baseQuery = query;
        if (conditions.length > 0) {
            baseQuery = query.where(and(...conditions));
        }
        const sortedQuery = baseQuery.orderBy(inventoryProductsTable.name);
        let finalQuery = sortedQuery;
        if (page && limit) {
            const p = parseInt(String(page)) || 1;
            const l = parseInt(String(limit)) || 10;
            finalQuery = sortedQuery.limit(l).offset((p - 1) * l);
        }
        const products = await finalQuery;
        let result = products.map((p) => ({
            ...p,
            unitPrice: p.unitPrice == null ? null : Number(p.unitPrice),
            lowStock: p.currentStock <= p.reorderThreshold,
        }));
        return res.json(result);
    }
    catch (err) {
        req.log.error({ err }, "List products error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/inventory/products", requireRole(...storeRoles), async (req, res) => {
    try {
        const { name, category, unit, currentStock, reorderThreshold, unitPrice, description } = req.body ?? {};
        if (!name || !category)
            return res.status(400).json({ error: "name and category are required" });
        const [product] = await db.insert(inventoryProductsTable).values({
            name: String(name),
            category: String(category),
            unit: unit ? String(unit) : "pcs",
            currentStock: currentStock != null ? Number(currentStock) : 0,
            reorderThreshold: reorderThreshold != null ? Number(reorderThreshold) : 10,
            unitPrice: unitPrice != null && unitPrice !== "" ? String(unitPrice) : null,
            description: description ?? null,
        }).returning();
        return res.status(201).json({ ...product, unitPrice: product.unitPrice == null ? null : Number(product.unitPrice), lowStock: product.currentStock <= product.reorderThreshold });
    }
    catch (err) {
        req.log.error({ err }, "Create product error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.patch("/inventory/products/:id", requireRole(...storeRoles), async (req, res) => {
    try {
        const data = req.body ?? {};
        const upd = {};
        if (data.name !== undefined)
            upd.name = data.name;
        if (data.category !== undefined)
            upd.category = data.category;
        if (data.unit !== undefined)
            upd.unit = data.unit;
        if (data.reorderThreshold !== undefined)
            upd.reorderThreshold = Number(data.reorderThreshold);
        if (data.unitPrice !== undefined)
            upd.unitPrice = data.unitPrice === "" || data.unitPrice == null ? null : String(data.unitPrice);
        if (data.description !== undefined)
            upd.description = data.description;
        // currentStock is intentionally NOT updatable here — must flow through stock movements
        const [updated] = await db.update(inventoryProductsTable).set(upd).where(eq(inventoryProductsTable.id, parseInt(String(req.params.id)))).returning();
        if (!updated)
            return res.status(404).json({ error: "Not found" });
        return res.json({ ...updated, unitPrice: updated.unitPrice == null ? null : Number(updated.unitPrice), lowStock: updated.currentStock <= updated.reorderThreshold });
    }
    catch (err) {
        req.log.error({ err }, "Update product error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.delete("/inventory/products/:id", requireRole(...storeRoles), async (req, res) => {
    try {
        const [deleted] = await db.delete(inventoryProductsTable).where(eq(inventoryProductsTable.id, parseInt(String(req.params.id)))).returning();
        if (!deleted)
            return res.status(404).json({ error: "Not found" });
        return res.json({ ok: true });
    }
    catch (err) {
        req.log.error({ err }, "Delete product error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ─── STOCK MOVEMENTS ──────────────────────────────────────────────────────
router.get("/inventory/stock-movements", requireRole(...storeRoles), async (req, res) => {
    try {
        const { productId, limit } = req.query;
        const products = await db.select().from(inventoryProductsTable);
        const productMap = Object.fromEntries(products.map((p) => [p.id, p.name]));
        let rows = await db.select().from(stockMovementsTable).orderBy(desc(stockMovementsTable.createdAt));
        if (productId)
            rows = rows.filter((r) => r.productId === parseInt(String(productId)));
        if (limit)
            rows = rows.slice(0, parseInt(String(limit)));
        return res.json(rows.map((m) => ({
            ...m,
            productName: productMap[m.productId] ?? `#${m.productId}`,
            createdAt: m.createdAt.toISOString(),
        })));
    }
    catch (err) {
        req.log.error({ err }, "List stock movements error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/inventory/stock-movements", requireRole(...storeRoles), async (req, res) => {
    try {
        const { productId, direction, quantity, reason, reference, notes } = req.body ?? {};
        if (!productId || !direction || !quantity)
            return res.status(400).json({ error: "productId, direction, quantity required" });
        if (!["in", "out"].includes(String(direction)))
            return res.status(400).json({ error: "direction must be 'in' or 'out'" });
        const qty = Number(quantity);
        if (!Number.isFinite(qty) || qty <= 0)
            return res.status(400).json({ error: "quantity must be a positive number" });
        const result = await db.transaction(async (tx) => {
            const delta = direction === "in" ? qty : -qty;
            // Atomic conditional update — prevents lost updates / negative stock under concurrency
            const [updated] = await tx.update(inventoryProductsTable)
                .set({ currentStock: sql `${inventoryProductsTable.currentStock} + ${delta}` })
                .where(direction === "out"
                ? sql `${inventoryProductsTable.id} = ${Number(productId)} AND ${inventoryProductsTable.currentStock} >= ${qty}`
                : eq(inventoryProductsTable.id, Number(productId)))
                .returning();
            if (!updated) {
                // Either product missing or insufficient stock
                const existing = await tx.select().from(inventoryProductsTable).where(eq(inventoryProductsTable.id, Number(productId)));
                if (!existing[0])
                    throw new Error("Product not found");
                throw new Error(`Insufficient stock (have ${existing[0].currentStock}, need ${qty})`);
            }
            const product = updated;
            const newStock = updated.currentStock;
            const [movement] = await tx.insert(stockMovementsTable).values({
                productId: product.id,
                direction: String(direction),
                quantity: qty,
                reason: reason ? String(reason) : "manual",
                reference: reference ?? null,
                notes: notes ?? null,
                recordedBy: req.user?.id ?? null,
            }).returning();
            return { movement, newStock, product };
        });
        return res.status(201).json({
            ...result.movement,
            createdAt: result.movement.createdAt.toISOString(),
            newStock: result.newStock,
            productName: result.product.name,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Internal server error";
        if (msg.includes("Insufficient stock") || msg.includes("Product not found")) {
            return res.status(400).json({ error: msg });
        }
        req.log.error({ err }, "Create stock movement error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ─── LOW STOCK ─────────────────────────────────────────────────────────────
router.get("/inventory/low-stock", requireRole(...storeRoles), async (_req, res) => {
    try {
        const rows = await db.select().from(inventoryProductsTable)
            .where(sql `${inventoryProductsTable.currentStock} <= ${inventoryProductsTable.reorderThreshold}`)
            .orderBy(inventoryProductsTable.currentStock);
        return res.json(rows.map((p) => ({
            ...p,
            unitPrice: p.unitPrice == null ? null : Number(p.unitPrice),
            lowStock: true,
            shortage: Math.max(0, p.reorderThreshold - p.currentStock),
        })));
    }
    catch (err) {
        _req.log.error({ err }, "Low stock error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ─── SUPPLIERS (vendors we have POs with) ──────────────────────────────────
router.get("/inventory/suppliers", requireRole(...storeRoles), async (_req, res) => {
    try {
        const pos = await db.select().from(purchaseOrdersTable);
        const vendors = await db.select().from(vendorsTable);
        const vendorIds = new Set(pos.map((p) => p.vendorId));
        const suppliers = vendors.filter((v) => vendorIds.has(v.id)).map((v) => {
            const myPos = pos.filter((p) => p.vendorId === v.id);
            const totalSpend = myPos.reduce((a, p) => a + Number(p.totalAmount), 0);
            return {
                ...v,
                rating: v.rating ? Number(v.rating) : null,
                registeredAt: v.registeredAt.toISOString(),
                poCount: myPos.length,
                totalSpend,
                lastOrderAt: myPos.length ? myPos.map(p => p.createdAt.getTime()).sort((a, b) => b - a)[0] : null,
            };
        });
        return res.json(suppliers);
    }
    catch (err) {
        _req.log.error({ err }, "List suppliers error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ─── PO RECEIVE (verify + push to stock) ────────────────────────────────────
// Body: { items: [{ name, quantity, productId }] }
// Verifies each PO line by name+qty matches and an explicit productId mapping
// is provided by the store manager. Creates stock movements in a transaction
// and updates PO status to 'received'.
router.post("/purchase-orders/:id/receive", requireRole(...storeRoles), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const pos = await db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, id));
        const po = pos[0];
        if (!po)
            return res.status(404).json({ error: "PO not found" });
        if (po.status === "received")
            return res.status(409).json({ error: "PO already received" });
        if (!po.adminAcceptedAt && (po.sourceRole ?? "admin") === "store_manager")
            return res.status(400).json({ error: "Admin must accept this store manager PO before receiving" });
        if (!po.vendorConfirmedAt)
            return res.status(400).json({ error: "Vendor must confirm this PO before receiving" });
        if (!["acknowledged", "invoiced", "delivered"].includes(po.status)) {
            return res.status(400).json({ error: `Cannot receive while PO is ${po.status}` });
        }
        const poItems = po.items ?? [];
        const submitted = (req.body?.items ?? []);
        if (!Array.isArray(submitted) || submitted.length !== poItems.length) {
            return res.status(400).json({ error: `Item count mismatch: PO has ${poItems.length} item(s), you submitted ${submitted?.length ?? 0}` });
        }
        const submittedTyped = submitted;
        // Verify name + qty + unit price match (case-insensitive name compare, 0.01 tolerance on price)
        for (let i = 0; i < poItems.length; i++) {
            const po_i = poItems[i];
            const s_i = submittedTyped[i];
            if (!s_i || !s_i.productId) {
                return res.status(400).json({ error: `Line ${i + 1}: choose a product to map "${po_i.name}" to` });
            }
            if (String(po_i.name).trim().toLowerCase() !== String(s_i.name ?? "").trim().toLowerCase()) {
                return res.status(400).json({ error: `Line ${i + 1}: name mismatch (PO: "${po_i.name}", invoice: "${s_i.name}")` });
            }
            if (Number(po_i.quantity) !== Number(s_i.quantity)) {
                return res.status(400).json({ error: `Line ${i + 1}: quantity mismatch (PO: ${po_i.quantity}, invoice: ${s_i.quantity})` });
            }
            if (s_i.unitPrice == null || !Number.isFinite(Number(s_i.unitPrice))) {
                return res.status(400).json({ error: `Line ${i + 1}: invoice unit price is required` });
            }
            if (Math.abs(Number(po_i.unitPrice) - Number(s_i.unitPrice)) > 0.01) {
                return res.status(400).json({ error: `Line ${i + 1}: amount mismatch (PO unit price: ₹${po_i.unitPrice}, invoice: ₹${s_i.unitPrice})` });
            }
        }
        const updated = await db.transaction(async (tx) => {
            for (let i = 0; i < submitted.length; i++) {
                const s_i = submitted[i];
                const qty = Number(s_i.quantity);
                const [updated] = await tx.update(inventoryProductsTable)
                    .set({ currentStock: sql `${inventoryProductsTable.currentStock} + ${qty}` })
                    .where(eq(inventoryProductsTable.id, Number(s_i.productId)))
                    .returning();
                if (!updated)
                    throw new Error(`Product #${s_i.productId} not found`);
                await tx.insert(stockMovementsTable).values({
                    productId: updated.id,
                    direction: "in",
                    quantity: qty,
                    reason: "po_received",
                    reference: po.poNumber,
                    notes: `Received via ${po.poNumber}`,
                    recordedBy: req.user?.id ?? null,
                });
            }
            const [u] = await tx.update(purchaseOrdersTable)
                .set({ status: "received" })
                .where(eq(purchaseOrdersTable.id, po.id))
                .returning();
            return u;
        });
        return res.json({
            ...updated,
            totalAmount: Number(updated.totalAmount),
            items: poItems,
            sourceRole: updated.sourceRole ?? "admin",
            adminAcceptedAt: updated.adminAcceptedAt ? updated.adminAcceptedAt.toISOString() : null,
            adminAcceptedBy: updated.adminAcceptedBy ?? null,
            vendorConfirmedAt: updated.vendorConfirmedAt ? updated.vendorConfirmedAt.toISOString() : null,
            vendorConfirmedBy: updated.vendorConfirmedBy ?? null,
            createdAt: updated.createdAt.toISOString(),
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Internal server error";
        if (msg.includes("not found") || msg.includes("mismatch")) {
            return res.status(400).json({ error: msg });
        }
        req.log.error({ err }, "PO receive error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ─── REPORTS ───────────────────────────────────────────────────────────────
router.get("/inventory/reports/summary", requireRole(...storeRoles), async (_req, res) => {
    try {
        const products = await db.select().from(inventoryProductsTable);
        const totalProducts = products.length;
        const totalStock = products.reduce((a, p) => a + p.currentStock, 0);
        const lowStockCount = products.filter((p) => p.currentStock <= p.reorderThreshold).length;
        const inventoryValue = products.reduce((a, p) => a + (Number(p.unitPrice ?? 0) * p.currentStock), 0);
        const byCategory = Object.entries(products.reduce((acc, p) => {
            const k = p.category;
            if (!acc[k])
                acc[k] = { products: 0, stock: 0, value: 0 };
            acc[k].products += 1;
            acc[k].stock += p.currentStock;
            acc[k].value += Number(p.unitPrice ?? 0) * p.currentStock;
            return acc;
        }, {})).map(([category, v]) => ({ category, ...v }));
        return res.json({ totalProducts, totalStock, lowStockCount, inventoryValue, byCategory });
    }
    catch (err) {
        _req.log.error({ err }, "Inventory summary error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/inventory/reports/usage", requireRole(...storeRoles), async (req, res) => {
    try {
        const { from, to, productId } = req.query;
        const products = await db.select().from(inventoryProductsTable);
        const pmap = Object.fromEntries(products.map((p) => [p.id, p]));
        let rows = await db.select().from(stockMovementsTable).orderBy(desc(stockMovementsTable.createdAt));
        if (from) {
            const f = new Date(String(from));
            if (!isNaN(f.getTime()))
                rows = rows.filter((r) => r.createdAt >= f);
        }
        if (to) {
            const t = new Date(String(to));
            if (!isNaN(t.getTime()))
                rows = rows.filter((r) => r.createdAt <= t);
        }
        if (productId)
            rows = rows.filter((r) => r.productId === parseInt(String(productId)));
        const totalIn = rows.filter((r) => r.direction === "in").reduce((a, r) => a + r.quantity, 0);
        const totalOut = rows.filter((r) => r.direction === "out").reduce((a, r) => a + r.quantity, 0);
        // Per-product usage breakdown
        const byProduct = Object.values(rows.reduce((acc, r) => {
            const p = pmap[r.productId];
            if (!acc[r.productId])
                acc[r.productId] = { productId: r.productId, productName: p?.name ?? `#${r.productId}`, category: p?.category ?? "", inQty: 0, outQty: 0, net: 0, movements: 0 };
            if (r.direction === "in")
                acc[r.productId].inQty += r.quantity;
            else
                acc[r.productId].outQty += r.quantity;
            acc[r.productId].net = acc[r.productId].inQty - acc[r.productId].outQty;
            acc[r.productId].movements += 1;
            return acc;
        }, {})).sort((a, b) => b.outQty - a.outQty);
        return res.json({
            totalIn,
            totalOut,
            movementCount: rows.length,
            byProduct,
            movements: rows.slice(0, 200).map((m) => ({
                ...m,
                productName: pmap[m.productId]?.name ?? `#${m.productId}`,
                createdAt: m.createdAt.toISOString(),
            })),
        });
    }
    catch (err) {
        req.log.error({ err }, "Usage report error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/inventory/reports/purchases", requireRole(...storeRoles), async (_req, res) => {
    try {
        const pos = await db.select().from(purchaseOrdersTable).orderBy(desc(purchaseOrdersTable.createdAt));
        const vendors = await db.select().from(vendorsTable);
        const vmap = Object.fromEntries(vendors.map((v) => [v.id, v.name]));
        const totalSpend = pos.reduce((a, p) => a + Number(p.totalAmount), 0);
        const receivedSpend = pos.filter((p) => p.status === "received").reduce((a, p) => a + Number(p.totalAmount), 0);
        return res.json({
            totalSpend,
            receivedSpend,
            orderCount: pos.length,
            orders: pos.map((p) => ({
                id: p.id,
                poNumber: p.poNumber,
                vendorName: vmap[p.vendorId] ?? `Vendor ${p.vendorId}`,
                items: Array.isArray(p.items) ? p.items.map((item) => ({
                    name: item?.name ?? "",
                    quantity: Number(item?.quantity ?? item?.qty ?? 0),
                })) : [],
                status: p.status,
                totalAmount: Number(p.totalAmount),
                createdAt: p.createdAt.toISOString(),
            })),
        });
    }
    catch (err) {
        _req.log.error({ err }, "Purchases report error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
export default router;

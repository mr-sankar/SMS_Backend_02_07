import { db } from "@workspace/db";
import { usersTable, staffTable} from "@workspace/db";
import { eq } from "drizzle-orm";
import cookieSignature from "cookie-signature";
const STAFF_AUTH_ROLES = new Set([
    "admin",
    "teacher",
    "accountant",
    "clerk",
    "hostel_warden",
    "transport_manager",
    "driver",
    "store_manager",
    "librarian",
]);

export async function isStaffAccountInactive(user) {
    if (!user || !STAFF_AUTH_ROLES.has(user.role))
        return false;

    let rows = await db
        .select({ status: staffTable.status })
        .from(staffTable)
        .where(eq(staffTable.userId, user.id));

    if (rows.length === 0 && user.email) {
        rows = await db
            .select({ status: staffTable.status })
            .from(staffTable)
            .where(eq(staffTable.email, user.email));
    }

    const staff = rows[0];
    return !!staff && staff.status !== "active";
}

export async function attachUser(req, _res, next) {
    try {
        // Only trust the signed httpOnly cookie set at login; never accept client-supplied headers
        // or unsigned cookies (cookie-parser places verified signed values on req.signedCookies)
        let raw = req.signedCookies?.userId;
        if (!raw && req.cookies?.userId?.startsWith("s:")) {
            const secret = req.secret || process.env.SESSION_SECRET || "dev-fallback-cookie-secret-change-me";
            const unsigned = cookieSignature.unsign(req.cookies.userId.slice(2), secret);
            if (unsigned !== false) {
                raw = unsigned;
            }
        }
        if (!raw)
            return next();
        const userId = parseInt(String(raw));
        if (Number.isNaN(userId))
            return next();
        const users = await db.select().from(usersTable).where(eq(usersTable.id, userId));
        const u = users[0];
        if (!u)
            return next();
        if (await isStaffAccountInactive(u)) {
            const isProd = process.env.NODE_ENV === "production";
            _res.clearCookie("userId", {
                httpOnly: true,
                signed: true,
                sameSite: isProd ? "none" : "lax",
                secure: isProd
            });
            return next();
        }
        req.user = {
            id: u.id,
            username: u.username,
            role: u.role,
            name: u.name,
            email: u.email,
            phone: u.phone ?? null,
        };
        return next();
    }
    catch (err) {
        req.log.error({ err }, "attachUser middleware error");
        return next();
    }
}
export function requireAuth(req, res, next) {
    if (!req.user)
        return res.status(401).json({ error: "Not authenticated" });
    return next();
}
export function requireRole(...allowed) {
    return (req, res, next) => {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        if (!allowed.includes(req.user.role)) {
            return res.status(403).json({ error: "Forbidden", details: `Role '${req.user.role}' not permitted` });
        }
        return next();
    };
}
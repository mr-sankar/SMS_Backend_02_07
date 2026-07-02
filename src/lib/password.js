import bcrypt from "bcryptjs";
const BCRYPT_ROUNDS = 10;
export async function hashPassword(plain) {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
}
export function isHashed(stored) {
    return typeof stored === "string" && /^\$2[aby]\$/.test(stored);
}
export async function verifyPassword(plain, stored) {
    if (!stored)
        return false;
    if (isHashed(stored)) {
        try {
            return await bcrypt.compare(plain, stored);
        }
        catch {
            return false;
        }
    }
    return stored === plain;
}

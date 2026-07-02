import { Storage } from "@google-cloud/storage";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import fs from "node:fs";
import path from "node:path";
import { ObjectPermission, canAccessObject, getObjectAclPolicy, setObjectAclPolicy, } from "./objectAcl";
const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

function isLocalFallbackActive() {
    return !process.env.PRIVATE_OBJECT_DIR;
}

function getLocalUploadsDir() {
    return process.env.VERCEL ? "/tmp/uploads" : path.resolve(process.cwd(), "uploads");
}

export const objectStorageClient = !isLocalFallbackActive() ? new Storage({
    credentials: {
        audience: "replit",
        subject_token_type: "access_token",
        token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
        type: "external_account",
        credential_source: {
            url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
            format: {
                type: "json",
                subject_token_field_name: "access_token",
            },
        },
        universe_domain: "googleapis.com",
    },
    projectId: "",
}) : null;

export class ObjectNotFoundError extends Error {
    constructor() {
        super("Object not found");
        this.name = "ObjectNotFoundError";
        Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
    }
}
export class ObjectStorageService {
    constructor() { }
    getPublicObjectSearchPaths() {
        if (isLocalFallbackActive()) {
            return ["uploads"];
        }
        const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
        const paths = Array.from(new Set(pathsStr
            .split(",")
            .map((path) => path.trim())
            .filter((path) => path.length > 0)));
        if (paths.length === 0) {
            throw new Error("PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
                "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths).");
        }
        return paths;
    }
    getPrivateObjectDir() {
        if (isLocalFallbackActive()) {
            return "uploads";
        }
        const dir = process.env.PRIVATE_OBJECT_DIR || "";
        if (!dir) {
            throw new Error("PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
                "tool and set PRIVATE_OBJECT_DIR env var.");
        }
        return dir;
    }
    async searchPublicObject(filePath) {
        if (isLocalFallbackActive()) {
            const localPath = path.resolve(getLocalUploadsDir(), filePath);
            if (fs.existsSync(localPath)) {
                return { isLocal: true, entityId: filePath };
            }
            return null;
        }
        for (const searchPath of this.getPublicObjectSearchPaths()) {
            const fullPath = `${searchPath}/${filePath}`;
            const { bucketName, objectName } = parseObjectPath(fullPath);
            const bucket = objectStorageClient.bucket(bucketName);
            const file = bucket.file(objectName);
            const [exists] = await file.exists();
            if (exists) {
                return file;
            }
        }
        return null;
    }
    async downloadObject(file, cacheTtlSec = 3600) {
        if (file.isLocal) {
            const localPath = path.resolve(getLocalUploadsDir(), file.entityId);
            const buffer = fs.readFileSync(localPath);
            let contentType = "application/octet-stream";
            try {
                const metaStr = fs.readFileSync(`${localPath}.json`, "utf8");
                const meta = JSON.parse(metaStr);
                contentType = meta.contentType || contentType;
            } catch (e) {
                // Ignore missing sidecar
            }
            const headers = {
                "Content-Type": contentType,
                "Cache-Control": `private, max-age=${cacheTtlSec}`,
                "Content-Length": String(buffer.length),
            };
            return new Response(Readable.toWeb(Readable.from(buffer)), { headers });
        }
        const [metadata] = await file.getMetadata();
        const aclPolicy = await getObjectAclPolicy(file);
        const isPublic = aclPolicy?.visibility === "public";
        const nodeStream = file.createReadStream();
        const webStream = Readable.toWeb(nodeStream);
        const headers = {
            "Content-Type": metadata.contentType || "application/octet-stream",
            "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
        };
        if (metadata.size) {
            headers["Content-Length"] = String(metadata.size);
        }
        return new Response(webStream, { headers });
    }
    // Server-side direct upload of a buffer (e.g. from a multipart request).
    // Returns the normalized /objects/<id> path. Use when the server itself is
    // ingesting the file so the client never sees a signed URL.
    async uploadObjectEntity(buffer, contentType, metadata = {}) {
        const objectId = randomUUID();
        if (isLocalFallbackActive()) {
            const localDir = getLocalUploadsDir();
            fs.mkdirSync(path.resolve(localDir, "uploads"), { recursive: true });
            const localPath = path.resolve(localDir, "uploads", objectId);
            fs.writeFileSync(localPath, buffer);
            fs.writeFileSync(`${localPath}.json`, JSON.stringify({ contentType, metadata }));
            return `/objects/uploads/${objectId}`;
        }
        const privateObjectDir = this.getPrivateObjectDir();
        const fullPath = `${privateObjectDir}/uploads/${objectId}`;
        const { bucketName, objectName } = parseObjectPath(fullPath);
        const bucket = objectStorageClient.bucket(bucketName);
        const file = bucket.file(objectName);
        await file.save(buffer, {
            contentType,
            resumable: false,
            metadata: { contentType, metadata },
        });
        let entityDir = privateObjectDir;
        if (!entityDir.endsWith("/"))
            entityDir = `${entityDir}/`;
        return `/objects/uploads/${objectId}`;
    }
    async getObjectEntityUploadURL() {
        if (isLocalFallbackActive()) {
            throw new Error("Local fallback does not support signed URLs");
        }
        const privateObjectDir = this.getPrivateObjectDir();
        if (!privateObjectDir) {
            throw new Error("PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
                "tool and set PRIVATE_OBJECT_DIR env var.");
        }
        const objectId = randomUUID();
        const fullPath = `${privateObjectDir}/uploads/${objectId}`;
        const { bucketName, objectName } = parseObjectPath(fullPath);
        return signObjectURL({
            bucketName,
            objectName,
            method: "PUT",
            ttlSec: 900,
        });
    }
    async getObjectEntityFile(objectPath) {
        if (!objectPath.startsWith("/objects/")) {
            throw new ObjectNotFoundError();
        }
        const parts = objectPath.slice(1).split("/");
        if (parts.length < 2) {
            throw new ObjectNotFoundError();
        }
        const entityId = parts.slice(1).join("/");
        if (isLocalFallbackActive()) {
            const localPath = path.resolve(getLocalUploadsDir(), entityId);
            if (fs.existsSync(localPath)) {
                return { isLocal: true, entityId };
            }
            const fallbackEntityId = path.basename(entityId);
            const fallbackPath = path.resolve(getLocalUploadsDir(), fallbackEntityId);
            if (fs.existsSync(fallbackPath)) {
                return { isLocal: true, entityId: fallbackEntityId };
            }
            throw new ObjectNotFoundError();
        }
        let entityDir = this.getPrivateObjectDir();
        if (!entityDir.endsWith("/")) {
            entityDir = `${entityDir}/`;
        }
        const objectEntityPath = `${entityDir}${entityId}`;
        const { bucketName, objectName } = parseObjectPath(objectEntityPath);
        const bucket = objectStorageClient.bucket(bucketName);
        const objectFile = bucket.file(objectName);
        const [exists] = await objectFile.exists();
        if (!exists) {
            throw new ObjectNotFoundError();
        }
        return objectFile;
    }
    normalizeObjectEntityPath(rawPath) {
        if (isLocalFallbackActive()) {
            return rawPath;
        }
        if (!rawPath.startsWith("https://storage.googleapis.com/")) {
            return rawPath;
        }
        const url = new URL(rawPath);
        const rawObjectPath = url.pathname;
        let objectEntityDir = this.getPrivateObjectDir();
        if (!objectEntityDir.endsWith("/")) {
            objectEntityDir = `${objectEntityDir}/`;
        }
        if (!rawObjectPath.startsWith(objectEntityDir)) {
            return rawObjectPath;
        }
        const entityId = rawObjectPath.slice(objectEntityDir.length);
        return `/objects/${entityId}`;
    }
    async trySetObjectEntityAclPolicy(rawPath, aclPolicy) {
        if (isLocalFallbackActive()) {
            return this.normalizeObjectEntityPath(rawPath);
        }
        const normalizedPath = this.normalizeObjectEntityPath(rawPath);
        if (!normalizedPath.startsWith("/")) {
            return normalizedPath;
        }
        const objectFile = await this.getObjectEntityFile(normalizedPath);
        await setObjectAclPolicy(objectFile, aclPolicy);
        return normalizedPath;
    }
    async canAccessObjectEntity({ userId, objectFile, requestedPermission, }) {
        if (objectFile.isLocal) {
            return true;
        }
        return canAccessObject({
            userId,
            objectFile,
            requestedPermission: requestedPermission ?? ObjectPermission.READ,
        });
    }
}
function parseObjectPath(path) {
    if (!path.startsWith("/")) {
        path = `/${path}`;
    }
    const pathParts = path.split("/");
    if (pathParts.length < 3) {
        throw new Error("Invalid path: must contain at least a bucket name");
    }
    const bucketName = pathParts[1];
    const objectName = pathParts.slice(2).join("/");
    return {
        bucketName,
        objectName,
    };
}
async function signObjectURL({ bucketName, objectName, method, ttlSec, }) {
    const request = {
        bucket_name: bucketName,
        object_name: objectName,
        method,
        expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
    };
    const response = await fetch(`${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw new Error(`Failed to sign object URL, errorcode: ${response.status}, ` +
            `make sure you're running on Replit`);
    }
    const { signed_url: signedURL } = (await response.json());
    return signedURL;
}


import { Router } from "express";
import multer from "multer";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { Readable } from "stream";

const router = Router();
const objectStorage = new ObjectStorageService();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

router.post("/upload", upload.single("file"), async (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: "File required" });
        }
        const objectPath = await objectStorage.uploadObjectEntity(file.buffer, file.mimetype, {
            originalName: file.originalname,
        });
        const id = objectPath.split("/").pop();
        return res.json({
            url: `/api/uploads/${id}`,
            path: objectPath,
        });
    }
    catch (err) {
        req.log.error({ err }, "Upload error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/uploads/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const objectPath = `/objects/uploads/${id}`;
        try {
            const file = await objectStorage.getObjectEntityFile(objectPath);
            const response = await objectStorage.downloadObject(file, 0);
            res.status(response.status);
            response.headers.forEach((value, key) => res.setHeader(key, value));
            if (response.body) {
                const nodeStream = Readable.fromWeb(response.body);
                nodeStream.pipe(res);
            }
            else {
                res.end();
            }
        }
        catch (e) {
            if (e instanceof ObjectNotFoundError) {
                return res.status(404).json({ error: "File not found" });
            }
            throw e;
        }
    }
    catch (err) {
        req.log.error({ err }, "Serve upload error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

export default router;


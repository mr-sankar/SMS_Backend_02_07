import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";
import { attachUser } from "./middlewares/auth";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);
app.use(pinoHttp({
    logger,
    serializers: {
        req(req) {
            return {
                id: req.id,
                method: req.method,
                url: req.url?.split("?")[0],
            };
        },
        res(res) {
            return {
                statusCode: res.statusCode,
            };
        },
    },
}));
app.use(cors({ origin: true, credentials: true }));
const COOKIE_SECRET = process.env.SESSION_SECRET || "dev-fallback-cookie-secret-change-me";
app.use(cookieParser(COOKIE_SECRET));
app.use((req, res, next) => {
    req.secret = COOKIE_SECRET;
    next();
});
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use("/api", attachUser);
app.use("/api", router);

const frontendDistPath = path.resolve(__dirname, "../../frontend/dist/public");
app.use(express.static(frontendDistPath));

app.use((req, res, next) => {
    if (req.path.startsWith("/api") || path.extname(req.path)) {
        return next();
    }
    res.sendFile(path.join(frontendDistPath, "index.html"));
});

export default app;

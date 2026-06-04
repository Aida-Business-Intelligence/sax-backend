import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { errorHandler } from "./middleware/errorHandler.js";
import authRoutes from "./routes/auth.js";
import warehouseRoutes from "./routes/warehouse.js";
import clientRoutes from "./routes/client.js";
import usersRoutes from "./routes/users.js";
import rolesRoutes from "./routes/roles.js";
import proprietariosRoutes from "./routes/proprietarios.js";
import ownerPortalRoutes from "./routes/owner-portal.js";
import sectionsRoutes from "./routes/sections.js";
import tagsRoutes from "./routes/tags.js";
import propertyTypesRoutes from "./routes/property-types.js";
import propertiesPublicRoutes from "./routes/properties-public.js";
import propriedadesRoutes from "./routes/propriedades.js";
import siteConfigRoutes from "./routes/site-config.js";
import blogRoutes from "./routes/blog.js";
import analyticsRoutes from "./routes/analytics.js";
import trackingRoutes from "./routes/tracking.js";
import automationsRoutes from "./routes/automations.js";
import foldersRoutes from "./routes/folders.js";
import filesRoutes from "./routes/files.js";
import fileStorageRoutes from "./routes/file-storage.js";
import integrationsRoutes from "./routes/integrations.js";
import mailRoutes from "./routes/mail.js";
import helpdeskRoutes from "./routes/helpdesk.js";
import settingsRoutes from "./routes/settings.js";
import leadsRoutes from "./routes/leads.js";
import negociosRoutes from "./routes/negocios.js";
import activitiesRoutes from "./routes/activities.js";
import hrRoutes from "./routes/hr.js";
import siteStoriesRoutes from "./routes/site-stories.js";
import publicFeedRoutes from "./routes/public-feed.js";
import liveMessagesPublicRoutes from "./routes/live-messages-public.js";
import liveChatPublicRoutes from "./routes/live-chat-public.js";
import receivablesRoutes from "./routes/receivables.js";
import originsRoutes from "./routes/origins.js";
import expensesRoutes from "./routes/expenses.js";
import expensesCategoriesRoutes from "./routes/expenses-categories.js";
import bankAccountsRoutes from "./routes/bank-accounts.js";
import suppliersRoutes from "./routes/suppliers.js";
import kanbanRoutes from "./routes/kanban.js";
import { metaLeadsWebhookRouter } from "./routes/webhooks-meta-leads.js";
import { googleLeadsWebhookRouter } from "./routes/webhooks-google-leads.js";

const app = express();

// Permite <img src="http://api:4000/uploads/..."> a partir do front em outra origem (dev: portas diferentes).
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.use(
  cors({
    origin: config.corsOrigin,
    credentials: true,
  }),
);

// Confia no primeiro proxy reverso (nginx/traefik) para leitura correta do IP real
app.set("trust proxy", 1);

/** Lead Ads Meta: corpo JSON bruto (obrigatório para validar X-Hub-Signature-256). */
app.use(
  "/api/webhooks/meta-leads",
  express.raw({ type: "application/json" }),
  metaLeadsWebhookRouter,
);

app.use(express.json({ limit: "100mb" }));

/** Leads Google / Zapier — JSON + header X-Sax-Webhook-Secret */
app.use("/api/webhooks/google-leads", googleLeadsWebhookRouter);

// Rate limit: em dev mais alto para não travar; em produção protege o servidor
const isDev = config.nodeEnv === "development";
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: isDev ? 2000 : 500,
    message: {
      success: false,
      message: "Muitas requisições. Tente novamente em alguns minutos.",
    },
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// Rotas públicas (login e listagem de lojas para o select no login)
app.use("/api/auth", authRoutes);
app.use("/api/warehouse", warehouseRoutes);
app.use("/api/client", clientRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/roles", rolesRoutes);
app.use("/api/proprietarios/portal", ownerPortalRoutes);
app.use("/api/proprietarios", proprietariosRoutes);
app.use("/api/sections", sectionsRoutes);
app.use("/api/tags", tagsRoutes);
app.use("/api/property-types", propertyTypesRoutes);
app.use("/api/public/feed", publicFeedRoutes);
app.use("/api/public/live-messages", liveMessagesPublicRoutes);
app.use("/api/public/live-chat", liveChatPublicRoutes);
app.use("/api/properties", propertiesPublicRoutes);
app.use("/api/propriedades", propriedadesRoutes);
app.use("/api/site-config", siteConfigRoutes);
app.use("/api/site-stories", siteStoriesRoutes);
app.use("/api/blog", blogRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/tracking", trackingRoutes);
app.use("/api/automations", automationsRoutes);
app.use("/api/folders", foldersRoutes);
app.use("/api/files", filesRoutes);
app.use("/api/file_storage", fileStorageRoutes);
app.use("/api/integrations", integrationsRoutes);
app.use("/api/mail", mailRoutes);
app.use("/api/helpdesk", helpdeskRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/leads", leadsRoutes);
app.use("/api/negocios", negociosRoutes);
app.use("/api/activities", activitiesRoutes);
app.use("/api/hr", hrRoutes);
app.use("/api/receivables", receivablesRoutes);
app.use("/api/origins", originsRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/expenses_categories", expensesCategoriesRoutes);
app.use("/api/BankAccounts", bankAccountsRoutes);
app.use("/api/suppliers", suppliersRoutes);
app.use("/api/kanban", kanbanRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "sax-backend" });
});

app.use(errorHandler);

export default app;

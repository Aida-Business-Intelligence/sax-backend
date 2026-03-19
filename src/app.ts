import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import warehouseRoutes from './routes/warehouse.js';
import clientRoutes from './routes/client.js';
import usersRoutes from './routes/users.js';
import rolesRoutes from './routes/roles.js';
import proprietariosRoutes from './routes/proprietarios.js';
import sectionsRoutes from './routes/sections.js';
import tagsRoutes from './routes/tags.js';
import propertiesPublicRoutes from './routes/properties-public.js';
import propriedadesRoutes from './routes/propriedades.js';
import siteConfigRoutes from './routes/site-config.js';
import blogRoutes from './routes/blog.js';
import analyticsRoutes from './routes/analytics.js';
import trackingRoutes from './routes/tracking.js';
import automationsRoutes from './routes/automations.js';
import foldersRoutes from './routes/folders.js';
import filesRoutes from './routes/files.js';
import fileStorageRoutes from './routes/file-storage.js';
import integrationsRoutes from './routes/integrations.js';
import mailRoutes from './routes/mail.js';

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigin,
    credentials: true,
  })
);
app.use(express.json());

// Arquivos enviados (imagens de imóveis, logos, etc.)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Rate limit: em dev mais alto para não travar; em produção protege o servidor
const isDev = config.nodeEnv === 'development';
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: isDev ? 2000 : 500,
    message: { success: false, message: 'Muitas requisições. Tente novamente em alguns minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Rotas públicas (login e listagem de lojas para o select no login)
app.use('/api/auth', authRoutes);
app.use('/api/warehouse', warehouseRoutes);
app.use('/api/client', clientRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/proprietarios', proprietariosRoutes);
app.use('/api/sections', sectionsRoutes);
app.use('/api/tags', tagsRoutes);
app.use('/api/properties', propertiesPublicRoutes);
app.use('/api/propriedades', propriedadesRoutes);
app.use('/api/site-config', siteConfigRoutes);
app.use('/api/blog', blogRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/automations', automationsRoutes);
app.use('/api/folders', foldersRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/file_storage', fileStorageRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/mail', mailRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'sax-backend' });
});

app.use(errorHandler);

export default app;

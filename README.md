# Lexia Legal — المنصة القانونية بالذكاء الاصطناعي

<div align="center">

**منصة قانونية مغربية مدعومة بالذكاء الاصطناعي**  
*Plateforme d'intelligence artificielle juridique marocaine*

</div>

---

## Description / الوصف

**Lexia Legal** est une plateforme d'intelligence artificielle spécialisée dans le droit marocain. Elle permet aux juristes, avocats, magistrats et citoyens d'interroger en langue arabe la base de données juridique marocaine (lois, décrets, jugements commerciaux, civils, administratifs, pénaux, familiaux, immobiliers et constitutionnels).

**لكسيا ليغال** منصة ذكاء اصطناعي متخصصة في القانون المغربي، تُمكِّن المحامين والقضاة والمواطنين من استشارة قاعدة البيانات القانونية المغربية باللغة العربية، وتشمل القوانين والمراسيم والأحكام القضائية بمختلف تخصصاتها.

---

## Prérequis / المتطلبات

| Outil | Version minimale |
|-------|-----------------|
| Docker | 24.0+ |
| Docker Compose | 2.20+ |
| RAM disponible | 8 Go minimum |
| Espace disque | 20 Go minimum |

---

## Installation / التثبيت

### 1. Cloner le dépôt / استنساخ المستودع

```bash
git clone https://github.com/your-org/lexia-legal.git
cd lexia-legal
```

### 2. Configurer les variables d'environnement / إعداد متغيرات البيئة

```bash
cp .env.example .env
```

Éditez le fichier `.env` et renseignez toutes les valeurs :

```bash
nano .env
```

Variables obligatoires à changer :

| Variable | Description |
|----------|-------------|
| `POSTGRES_PASSWORD` | Mot de passe PostgreSQL (application) |
| `KEYCLOAK_ADMIN_PASSWORD` | Mot de passe administrateur Keycloak |
| `KEYCLOAK_DB_PASSWORD` | Mot de passe PostgreSQL (Keycloak) |
| `KEYCLOAK_CLIENT_SECRET` | Secret du client backend Keycloak |
| `REDIS_PASSWORD` | Mot de passe Redis |
| `QDRANT_API_KEY` | Clé API Qdrant |
| `MINIO_SECRET_KEY` | Clé secrète MinIO |
| `OPENAI_API_KEY` | Clé API OpenAI |
| `MISTRAL_API_KEY` | Clé API Mistral AI |
| `ENCRYPTION_KEY` | Clé de chiffrement AES-256 (32 caractères) |
| `JWT_SECRET` | Secret JWT interne |

### 3. Démarrer la plateforme / تشغيل المنصة

```bash
docker compose -f deploy/docker-compose.yml up -d
```

Pour suivre les logs :

```bash
docker compose -f deploy/docker-compose.yml logs -f
```

### 4. Vérifier le démarrage / التحقق من بدء التشغيل

```bash
docker compose -f deploy/docker-compose.yml ps
```

Tous les services doivent afficher le statut `running` ou `healthy`.

---

## URLs des services / روابط الخدمات

| Service | URL | Description |
|---------|-----|-------------|
| Frontend | http://localhost | Interface utilisateur React |
| API Backend | http://localhost/api | API REST NestJS |
| Swagger / Docs | http://localhost/docs | Documentation OpenAPI interactive |
| Keycloak Admin | http://localhost:8080/admin | Console d'administration IAM |
| MinIO Console | http://localhost:9001 | Console de gestion des fichiers |
| Bull Board | http://localhost:3001 | Tableau de bord des files de tâches |
| Lexia Admin | http://localhost:5175 | Interface admin agent (lexia-admin) |
| Lexia Agent API | http://localhost:6002 | API unifiée better-auth + proxy agent |

---

## Architecture / البنية التقنية

```
┌─────────────────────────────────────────────────────────────┐
│                     Nginx (Port 80)                          │
│              Reverse Proxy + Load Balancer                   │
└─────────────┬───────────────────────┬───────────────────────┘
              │                       │
    ┌─────────▼──────────┐  ┌────────▼───────────┐
    │  Frontend (React)  │  │  Backend (NestJS)  │
    │     Port 3000      │  │     Port 4000      │
    └────────────────────┘  └────────┬───────────┘
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          │                          │                           │
┌─────────▼──────────┐  ┌──────────▼─────────┐  ┌────────────▼────────┐
│   PostgreSQL 16    │  │   Qdrant (Vecteurs) │  │   MinIO (Fichiers)  │
│   Base de données  │  │   Recherche RAG     │  │   PDFs & exports    │
└────────────────────┘  └─────────────────────┘  └─────────────────────┘
          │                                                      │
┌─────────▼──────────┐  ┌─────────────────────┐
│   Keycloak 24      │  │   Redis 7           │
│   IAM & SSO        │  │   Cache + BullMQ    │
└────────────────────┘  └─────────────────────┘
```

### Composants principaux / المكونات الرئيسية

| Composant | Technologie | Rôle |
|-----------|-------------|------|
| Frontend | React + Vite + TypeScript | Interface utilisateur arabe RTL |
| Backend | NestJS + TypeScript | API REST, orchestration RAG, BullMQ |
| Base de données | PostgreSQL 16 | Métadonnées documents, utilisateurs, facturation |
| Vecteurs | Qdrant | Recherche sémantique arabe (RAG) |
| Stockage | MinIO | PDFs, documents numérisés, exports |
| Auth | Keycloak 24 | SSO, OIDC, gestion des rôles |
| Cache / Queue | Redis 7 + BullMQ | Rate limiting, OCR, scraping, embedding |
| Proxy | Nginx | Reverse proxy, SSE streaming, compression |

---

## Niveaux d'accès / مستويات الوصول

| Rôle | Accès | Fonctionnalités |
|------|-------|----------------|
| **PUBLIC** | Sans compte | Recherche limitée (10 messages/jour), lois publiques uniquement |
| **PRO** | Abonnement 199 MAD/mois | 100 messages/jour, toutes collections, sources, export, upload |
| **ADMIN** | Interne | Gestion du contenu, validation des documents, supervision des jobs |
| **SUPERADMIN** | Interne | Accès complet, gestion des utilisateurs, configuration système |

---

## Collections documentaires / مجموعات الوثائق

| Collection | Description |
|------------|-------------|
| `legal_laws` | Dahirs, lois, décrets, arrêtés |
| `judgments_commercial` | Jugements tribunaux de commerce |
| `judgments_civil` | Jugements tribunaux civils |
| `judgments_admin` | Arrêts tribunaux administratifs |
| `judgments_criminal` | Arrêts chambres criminelles |
| `judgments_family` | Jugements sections de la famille |
| `judgments_social` | Arrêts chambres sociales |
| `judgments_real_estate` | Jugements immobiliers et fonciers |
| `judgments_constitutional` | Décisions Cour Constitutionnelle |
| `user_documents` | Documents privés uploadés par les utilisateurs |

---

## Commandes utiles / أوامر مفيدة

```bash
# Arrêter la plateforme / إيقاف المنصة
docker compose -f deploy/docker-compose.yml down

# Arrêter et supprimer les volumes (ATTENTION : perte de données)
docker compose -f deploy/docker-compose.yml down -v

# Reconstruire un service spécifique
docker compose -f deploy/docker-compose.yml build lexia-backend
docker compose -f deploy/docker-compose.yml up -d lexia-backend

# Voir les logs d'un service
docker compose -f deploy/docker-compose.yml logs -f lexia-backend
docker compose -f deploy/docker-compose.yml logs -f keycloak

# Accéder au shell PostgreSQL
docker compose -f deploy/docker-compose.yml exec postgres psql -U legal_ai -d legal_ai

# Accéder au shell Redis
docker compose -f deploy/docker-compose.yml exec redis redis-cli -a ${REDIS_PASSWORD}

# Sauvegarder la base de données
docker compose -f deploy/docker-compose.yml exec postgres pg_dump -U legal_ai legal_ai > backup_$(date +%Y%m%d).sql
```

---

## Licence / الترخيص

Propriétaire — Tous droits réservés © 2025 Lexia Legal  
جميع الحقوق محفوظة © 2025 لكسيا ليغال

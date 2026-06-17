# Social Monitor Implementation Plan: Separation, Login & RBAC

## Executive Summary
This document outlines the step-by-step implementation plan for adding frontend/backend separation, web login functionality with JWT authentication, and Role-Based Access Control (RBAC) to the existing `social-monitor` Express application.

## 1. Database Schema Changes (Users & Roles Tracking)
Currently, only `messages` and `accounts` tables exist in `db/database.sqlite`.

**Target**: `social-monitor/db/database.js`

**Plan**:
1. Add a new `users` schema with role tracking functionality to `initSchema()`:
   ```sql
   CREATE TABLE IF NOT EXISTS users (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       username TEXT UNIQUE NOT NULL,
       password_hash TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'viewer', -- 'admin', 'viewer'
       created_at DATETIME DEFAULT (datetime('now')),
       last_login DATETIME
   );
   ```
2. Create an admin user seed function if no users exist (default username/password to `admin`/`admin123` or similar via bcrypt).

## 2. Backend Architecture Changes

**Required Dependencies**:
- `jsonwebtoken` (for creating/verifying JWTs)
- `bcrypt` (for password hashing before saving to DB)
*Run: `npm install jsonwebtoken bcrypt`*

**Target**: `social-monitor/server.js` (and potentially a new `auth.js` helper)

**Plan**:
1. **Separation of API vs Frontend**:
   - The current setup serves static files and has API endpoints in the same file. I will maintain `app.use(express.static(publicDir))` but intercept protected API routes using middleware.
2. **Auth Endpoints**:
   - `POST /api/auth/login`: Accepts `{ username, password }`, checks bcrypt hash against DB, and returns signed JWT (e.g., `res.json({ token, user: { role } })`).
   - `GET /api/auth/me`: Validates token and returns current user info.
3. **Middleware Implementation**:
   - `authMiddleware(req, res, next)`: Extracts `Bearer` token from header, uses `jwt.verify()`, and attaches `req.user`. Returns 401 if missing/invalid.
   - `rbacMiddleware(allowedRoles)`: Checks `req.user.role`. Returns 403 if unauthorized.
4. **Secure Endpoints**:
   - Apply `authMiddleware` to all `/api/*` endpoints except `/api/auth/login`.
   - Apply `rbacMiddleware(['admin'])` to destructive or configuration endpoints (e.g., `/api/accounts/*` modification, `/config/*`, `DELETE` operations).
   - Allow `viewer` role to access read-only data (e.g., `/api/stats`, `/api/messages`, `GET` requests for dashboards).

## 3. Frontend Architecture Changes

**Target**: `social-monitor/public/index.html` (Current size: ~226KB)

**Plan**:
To maintain the monolithic vanilla JS/HTML file without introducing a complex build system or breaking current flow, we will adapt the UI structure natively:

1. **Token Storage & Interceptor**:
   - Store JWT in `localStorage.setItem('auth_token', token)`.
   - Update `fetch()` calls globally to append `Authorization: Bearer <token>`.
   - Modify error handling to catch 401s globally and redirect/show the Login view.
2. **Login View vs Main App View**:
   - Wrap the main application contents (`<aside class="sidebar">`, `<main class="main">`) in an `<div id="app-container" style="display:none">`.
   - Add a new `<div id="login-container">` containing the login form.
3. **Routing/Access Guards**:
   - At load, check for `token`.
   - If invalid or missing, show `login-container` and hide `app-container`.
   - If valid, fetch `/api/auth/me` to get role. Then show `app-container` and hide `login-container`.
4. **RBAC UI Adapation**:
   - Use the fetched user role to hide elements non-admins shouldn't see.
   - For example: if `role !== 'admin'`, dynamically hide the Sidebar links or buttons for Account Management, Config, and action buttons (`style.display = 'none'`).

## Critical Files for Implementation
- `/Users/a2026/Desktop/社媒监控/社媒监控系统/social-monitor/server.js`
- `/Users/a2026/Desktop/社媒监控/社媒监控系统/social-monitor/public/index.html`
- `/Users/a2026/Desktop/社媒监控/社媒监控系统/social-monitor/db/database.js`
- `/Users/a2026/Desktop/社媒监控/社媒监控系统/social-monitor/package.json`

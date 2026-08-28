# UInventario Mobile

Cliente móvil Expo para UInventario. Este repositorio contiene el shell y la configuración de
navegación; las reglas de inventario permanecen en la API versionada.

## Desarrollo local

Requiere Node.js 22 y npm.

```powershell
npm ci
Copy-Item .env.example .env.local
npm start
```

Desde Expo CLI se puede abrir Android, iOS o Web. `.env.local` sólo debe contener configuración
pública. Las variables con prefijo `EXPO_PUBLIC_` se incorporan al bundle y nunca deben usarse para
tokens, contraseñas o claves privadas.

## Ambientes

- `development` consume la API de Dev de Cloud Run.
- `production` consume la API de Prod mediante el perfil `production` de `eas.json`.

Los perfiles mantienen separados los endpoints públicos. Las futuras credenciales de sesión se
guardarán en almacenamiento seguro del dispositivo y no en variables de build.

## Validación

```powershell
npm run verify
```

El gate ejecuta lint, typecheck, Expo Doctor y genera los bundles de producción para Android e iOS.
GitHub Actions ejecuta el mismo gate en PRs y en las ramas `develop` y `master`.

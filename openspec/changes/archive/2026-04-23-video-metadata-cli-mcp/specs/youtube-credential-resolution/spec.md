# youtube-credential-resolution Specification

## Purpose

Definir resolución segura de credenciales de YouTube fuera del contexto web para permitir ejecución confiable desde CLI y MCP.

## Requirements

### Requirement: Resolución de credenciales fuera de sesión web

El sistema MUST resolver credenciales sin depender de `getServerSession` y SHALL entregar un contexto de autenticación utilizable por el core.

#### Scenario: Resolución exitosa para adapter no-web

- GIVEN ejecución desde CLI o MCP con fuente de credenciales configurada
- WHEN se inicializa el contexto de auth
- THEN se devuelve un contexto válido para llamadas de YouTube API

### Requirement: Verificación de permisos y scopes requeridos

El sistema MUST validar que las credenciales incluyan scopes necesarios para lectura y actualización de metadata.

#### Scenario: Scopes insuficientes

- GIVEN credenciales sin permisos de actualización
- WHEN se intenta iniciar operación de update
- THEN se rechaza con error de autorización tipado y accionable

### Requirement: Manejo robusto de renovación y fallas de auth

El sistema SHOULD manejar renovación de token cuando corresponda y MUST propagar fallas de auth en formato de error de dominio consistente.

#### Scenario: Token expirado sin renovación posible

- GIVEN un token expirado y renovación fallida
- WHEN se ejecuta cualquier caso de uso del core
- THEN la operación falla con error de autenticación consistente para CLI y MCP

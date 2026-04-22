import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { db, users } from "./db";
import { eq } from "drizzle-orm";

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope:
            "openid email profile https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube",
          access_type: "offline",
          prompt: "select_account consent",
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (!account) return false;

      const [existing] = await db
        .select()
        .from(users)
        .where(eq(users.id, user.id));

      if (existing) {
        await db
          .update(users)
          .set({
            name: user.name,
            email: user.email!,
            image: user.image,
            accessToken: account.access_token,
            refreshToken: account.refresh_token ?? existing.refreshToken,
            tokenExpiry: account.expires_at,
          })
          .where(eq(users.id, user.id));
      } else {
        await db.insert(users).values({
          id: user.id,
          name: user.name,
          email: user.email!,
          image: user.image,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          tokenExpiry: account.expires_at,
        });
      }

      return true;
    },
    async session({ session, token }) {
      if (token.sub) {
        session.user = { ...session.user, id: token.sub };
      }
      return session;
    },
    async jwt({ token }) {
      return token;
    },
  },
};

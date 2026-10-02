-- AlterTable
ALTER TABLE "BoardMember" ADD COLUMN     "addedById" TEXT,
ADD COLUMN     "guestId" TEXT,
ADD COLUMN     "guestName" VARCHAR(40),
ADD COLUMN     "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "shareLinkId" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ShareLink" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoardInvite" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "role" "Role" NOT NULL,
    "invitedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "BoardInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShareLink_token_key" ON "ShareLink"("token");

-- CreateIndex
CREATE INDEX "ShareLink_boardId_idx" ON "ShareLink"("boardId");

-- CreateIndex
CREATE INDEX "BoardInvite_email_idx" ON "BoardInvite"("email");

-- CreateIndex
CREATE UNIQUE INDEX "BoardInvite_boardId_email_key" ON "BoardInvite"("boardId", "email");

-- CreateIndex
CREATE INDEX "BoardMember_shareLinkId_idx" ON "BoardMember"("shareLinkId");

-- CreateIndex
CREATE UNIQUE INDEX "BoardMember_boardId_guestId_key" ON "BoardMember"("boardId", "guestId");

-- AddForeignKey
ALTER TABLE "BoardMember" ADD CONSTRAINT "BoardMember_shareLinkId_fkey" FOREIGN KEY ("shareLinkId") REFERENCES "ShareLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardInvite" ADD CONSTRAINT "BoardInvite_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Invariants Prisma's schema language cannot express. Enforced by the
-- database so no code path can violate them.

-- A member is exactly one of: a user, or a guest.
ALTER TABLE "BoardMember" ADD CONSTRAINT "BoardMember_user_xor_guest"
  CHECK (("userId" IS NULL) <> ("guestId" IS NULL));

-- At most one LIVE share link per board (decision D-3). Revoked links stay,
-- so an old token answers "turned off" rather than "invalid".
CREATE UNIQUE INDEX "ShareLink_one_live_per_board" ON "ShareLink"("boardId")
  WHERE "revokedAt" IS NULL;

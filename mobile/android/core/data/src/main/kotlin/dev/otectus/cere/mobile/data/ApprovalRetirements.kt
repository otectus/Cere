package dev.otectus.cere.mobile.data

import dev.otectus.cere.mobile.protocol.Approval

/** The signed fields that distinguish one approval request from a later reuse of its ID. */
internal data class ApprovalIdentity(val id: String, val revision: String, val digest: String)

internal fun Approval.identity() = ApprovalIdentity(id, revision, digest)

/**
 * Prevents a snapshot read before a terminal approval response from restoring
 * that exact request. A later request with a new revision or digest stays visible.
 */
internal class ApprovalRetirements {
    private val retired = LinkedHashSet<ApprovalIdentity>()

    @Synchronized fun retire(identity: ApprovalIdentity) {
        retired.remove(identity)
        retired.add(identity)
    }

    @Synchronized fun visible(approvals: List<Approval>): List<Approval> {
        val identities = approvals.mapTo(mutableSetOf()) { it.identity() }
        val visible = approvals.filterNot { it.identity() in retired }
        // Reconciliation is serialized, so absence from this applied snapshot
        // proves that no earlier snapshot remains to resurrect the tombstone.
        retired.retainAll(identities)
        return visible
    }

    @Synchronized fun clear() = retired.clear()
}

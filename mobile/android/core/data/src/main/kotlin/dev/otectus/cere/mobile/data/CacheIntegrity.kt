package dev.otectus.cere.mobile.data

/** Consistency between image records in the encrypted cache and the encrypted image files beside it. */
internal object CacheIntegrity {
    /**
     * Returns (files no record refers to, records whose file is gone). [filesListed] is false when the
     * directory could not be read, in which case nothing is judged missing.
     */
    fun blobs(recorded: Set<String>, files: Set<String>, filesListed: Boolean): Pair<Set<String>, Set<String>> =
        (files - recorded) to (if (filesListed) recorded - files else emptySet())
}

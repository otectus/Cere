package dev.otectus.cere.mobile.protocol

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CitationsTest {
    /** The corpus broker/citations.ts and native/citations.h are checked against. */
    @Test fun everySharedCaseStripsTheSameWayAsTheDesktop() {
        val cases = WireCodec.json.parseToJsonElement(SharedFixtures.text("tests/fixtures/memory-citations.json")).jsonArray
        assertTrue(cases.size >= 30)
        for (case in cases) {
            val value = case.jsonObject
            val name = value.getValue("name").jsonPrimitive.content
            assertEquals(name, value.getValue("output").jsonPrimitive.content, Citations.strip(value.getValue("input").jsonPrimitive.content))
        }
    }

    @Test fun visibleCitationsAndTextWithoutMarkersAreUnchanged() {
        val cited = "You prefer Ruff [evidence:ea105855-1459-41da-b270-d370d2b54457]."
        assertEquals(cited, Citations.shown(cited, showCitations = true))
        assertEquals("You prefer Ruff.", Citations.shown(cited, showCitations = false))
        val plain = "No markers | here\n```kotlin\nval x = 1\n```"
        assertTrue(Citations.strip(plain) === plain)
    }

    @Test fun aMarkerStillStreamingInIsHiddenUntilItCompletes() {
        assertEquals("You prefer Ruff", Citations.strip("You prefer Ruff [evidence:ea105855-14"))
        assertEquals("You prefer Ruff", Citations.strip("You prefer Ruff ([evidence:ea10"))
        // Until "evidence:" has arrived nothing marks it as a citation, as on the desktop.
        assertEquals("You prefer Ruff ([", Citations.strip("You prefer Ruff (["))
        assertEquals("Arrays use [0] indexing", Citations.strip("Arrays use [0] indexing"))
    }
}

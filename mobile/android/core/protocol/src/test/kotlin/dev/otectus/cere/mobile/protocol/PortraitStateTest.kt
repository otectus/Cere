package dev.otectus.cere.mobile.protocol

import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PortraitStateTest {
    @Test fun phonePortraitFollowsTheDesktopRule() {
        val cases = Json.parseToJsonElement(SharedFixtures.text("tests/fixtures/portrait-states.json")).jsonObject.getValue("cases").jsonArray
        assertTrue(cases.size >= 10)
        for (case in cases.map(JsonElement::jsonObject)) {
            val input = case.getValue("input").jsonObject; val expected = case.getValue("expected").jsonObject
            val resolved = PortraitState.resolve(
                connected = input["connected"]?.jsonPrimitive?.booleanOrNull ?: true,
                status = input.getValue("status").jsonPrimitive.content,
                activity = input["activity"]?.jsonPrimitive?.contentOrNull,
                approvals = input["approvals"]?.jsonPrimitive?.intOrNull ?: 0,
                paused = input["paused"]?.jsonPrimitive?.booleanOrNull ?: false)
            assertEquals(input.toString(), PortraitState.Resolved(expected.getValue("expression").jsonPrimitive.content,
                expected.getValue("label").jsonPrimitive.content, expected.getValue("tone").jsonPrimitive.content), resolved)
        }
    }

    @Test fun activityLabelsAreTheDesktopsWords() {
        val labels = Json.parseToJsonElement(SharedFixtures.text("tests/fixtures/activity-labels.json")).jsonObject.getValue("labels").jsonObject
        assertTrue(labels.size >= 8)
        for ((activity, label) in labels) assertEquals(activity, label.jsonPrimitive.content, activityLabel(activity))
        assertEquals(null, activityLabel("future-activity"))
    }
}

package dev.otectus.cere.mobile

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import dev.otectus.cere.mobile.protocol.ConversationBehavior
import dev.otectus.cere.mobile.protocol.Message
import dev.otectus.cere.mobile.protocol.WireCodec
import org.junit.Rule
import org.junit.Test

/** MOB-002 and MOB-005 on the real screen code, with payloads the desktop actually sends. */
class CompatibilityScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private fun show(json: String) {
        val behavior = WireCodec.json.decodeFromString(ConversationBehavior.serializer(), json)
        compose.setContent { MaterialTheme { androidx.compose.foundation.layout.Column { ConversationStyleContent(behavior) } } }
    }

    // The desktop's answer for a conversation without a style: profile and posture are JSON null.
    @Test fun theDefaultStyleWithExplicitNullsRendersNoStyle() {
        show("""{"source":"global","profile":null,"posture":null,"standingInstructions":false,"warnings":[]}""")
        compose.onNodeWithText("No style · the personality, for every conversation").assertIsDisplayed()
    }

    @Test fun aProfileWithoutAPostureRenders() {
        show("""{"source":"project","profile":{"label":"Concise"},"posture":null,"standingInstructions":false,"warnings":[]}""")
        compose.onNodeWithText("Concise · set for this project").assertIsDisplayed()
    }

    @Test fun aPostureWithoutAProfileRenders() {
        show("""{"source":"session","profile":null,"posture":{"label":"Careful","pinned":true},"standingInstructions":true,"warnings":["Tool ceiling applies"]}""")
        compose.onNodeWithText("No style · set for this conversation").assertIsDisplayed()
        compose.onNodeWithText("Posture: Careful · pinned to this conversation").assertIsDisplayed()
        compose.onNodeWithText("Tool ceiling applies").assertIsDisplayed()
    }

    @Test fun bothAndAnOlderSparseAnswerRender() {
        show("""{"source":"session","profile":{"label":"Teacher"},"posture":{"label":"Brief","pinned":false},"standingInstructions":false,"warnings":[]}""")
        compose.onNodeWithText("Teacher · set for this conversation").assertIsDisplayed()
        compose.onNodeWithText("Posture: Brief").assertIsDisplayed()
    }

    @Test fun anOlderAnswerWithoutOptionalFieldsRenders() {
        show("""{"source":"global"}""")
        compose.onNodeWithText("No style · the personality, for every conversation").assertIsDisplayed()
    }

    // A Workbench result is a desktop-only reference, never its contents.
    @Test fun aWorkbenchResultShowsWhereToViewIt() {
        val card = WireCodec.json.decodeFromString(Message.serializer(), """{"id":"m","sessionId":"s","role":"workbench","kind":"changes","text":"Proposed file changes · view this result on the desktop.","revision":"1","desktopOnly":{"kind":"changes","label":"Proposed file changes"}}""")
        compose.setContent { MaterialTheme { DesktopResultCard(card) } }
        compose.onNodeWithText("Proposed file changes").assertIsDisplayed()
        compose.onNodeWithText("View this result on the desktop. Its files, images and review stay there.").assertIsDisplayed()
    }
}

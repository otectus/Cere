package dev.otectus.cere.mobile

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasSetTextAction
import org.junit.Rule
import org.junit.Test

class PairingSmokeTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun freshInstallShowsCompletePairingEntryPoints() {
        compose.onNodeWithContentDescription("Cere").assertIsDisplayed()
        compose.onNodeWithText("Connect to Cere").assertIsDisplayed()
        compose.onAllNodes(hasSetTextAction()).assertCountEquals(2)
        compose.onNodeWithText("Verify offer").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Scan").performScrollTo().assertIsDisplayed()
    }
}

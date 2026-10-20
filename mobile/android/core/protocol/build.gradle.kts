plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

dependencies {
    api(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.core)
    testImplementation(libs.junit)
}

java {
    toolchain.languageVersion.set(JavaLanguageVersion.of(17))
}

// Cross-language fixtures (signing vectors, response conformance, citation corpus) are read from the
// repository, so Kotlin checks the same files as the broker's tests.
val repositoryRoot = rootProject.projectDir.resolve("../..").canonicalFile
tasks.withType<Test>().configureEach {
    systemProperty("cere.repositoryRoot", repositoryRoot.path)
    inputs.dir(repositoryRoot.resolve("protocol/mobile/v1")).withPropertyName("protocolFixtures")
    inputs.file(repositoryRoot.resolve("tests/fixtures/memory-citations.json")).withPropertyName("citationFixtures")
    inputs.file(repositoryRoot.resolve("tests/fixtures/portrait-states.json")).withPropertyName("portraitFixtures")
    inputs.file(repositoryRoot.resolve("tests/fixtures/activity-labels.json")).withPropertyName("activityFixtures")
}

<?php

if ( ! function_exists( 'fixture_button' ) ) {
	/**
	 * Print a button.
	 *
	 * @param string $label   Button text.
	 * @param array  $options {
	 *     @type string $variant Style. Default 'primary'.
	 * }
	 */
	function fixture_button( string $label, array $options = [] ): void {
		$options = wp_parse_args( $options, [ 'variant' => 'primary', 'size' => 'md' ] );
		echo esc_html( $label );
	}
}

$card = new \Fixture\Card();
echo $card->render( [ 'title' => 'Hello' ], [ 'className' => 'is-wide' ] );
fixture_button( 'Go', [ 'variant' => 'secondary' ] );

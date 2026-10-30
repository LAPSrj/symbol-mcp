<?php

namespace Shop;

class Report {
	public function render(): string {
		return 'report';
	}

	public function build( Cart $cart, $unknown ): string {
		$report = new Report();
		$out    = $report->render();
		$out   .= $cart->render();
		$out   .= $unknown->render();
		return $out;
	}
}
